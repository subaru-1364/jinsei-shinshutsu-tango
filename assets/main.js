// 初期サンプルテキスト（単語中心のシンプルな例）
const DEFAULT_BULK_TEXT = `大吉 : 最高の運勢。すべて順調に進む兆し。
中吉
小吉
イノベーション : 新しい技術や発想を取り入れた革新のこと。
アイディア`;

let wordList = [];
let isDrawing = false;
let editingWordId = null;
let currentFilterTab = sessionStorage.getItem("kuji_filter_tab") || "has";
let hasUserSelectedTab = Boolean(sessionStorage.getItem("kuji_filter_tab"));

// Firebase 設定・同期用変数
const firebaseConfig = {
    apiKey: "AIzaSyAL_BJS66V2_LK7v_IyG1RlX5QohsfaoOw",
    authDomain: "jinsei-tango-a3d1e.firebaseapp.com",
    databaseURL: "https://jinsei-tango-a3d1e-default-rtdb.firebaseio.com",
    projectId: "jinsei-tango-a3d1e",
    storageBucket: "jinsei-tango-a3d1e.firebasestorage.app",
    messagingSenderId: "481947502597",
    appId: "1:481947502597:web:5ab8bc4f33fe0ae2c7346c",
    measurementId: "G-5N9QWBP59C"
};

let fbAuth = null;
let fbDb = null;
let currentUser = null;
let activeDbRef = null;
let cloudSaveTimer = null;

// ① ページ読み込み時の初期化
window.addEventListener("DOMContentLoaded", function() {
    initApp();
    initFirebase();
});

function initApp() {
    recoverOriginalUserData(); // ユーザーの元データを最優先で救出・復元
    syncWordList();
    refreshUI();
}

function refreshUI() {
    // 編集画面（edit.html）の場合
    var textarea = document.getElementById("bulk-input");
    if (textarea) {
        var saved = localStorage.getItem("kuji_bulk_text") || localStorage.getItem("kuji_items") || "";
        if (document.activeElement !== textarea || textarea.value !== saved) {
            textarea.value = saved;
        }
        updateWordCountBadge(wordList.length);
    }

    // 一覧画面（index.html）の場合
    var wordListContainer = document.getElementById("word-list");
    if (wordListContainer) {
        var searchInput = document.getElementById("search-input");
        var keyword = searchInput ? searchInput.value : "";
        renderWordCards(keyword);
    }
}

// ローカル保存＋クラウド同期の一括ヘルパー
function saveBulkText(newText, debounceCloud) {
    var now = Date.now();
    localStorage.setItem("kuji_bulk_text", newText);
    localStorage.setItem("kuji_items", newText);
    localStorage.setItem("kuji_pending_sync", "1");
    localStorage.setItem("kuji_updated_at", String(now));
    syncWordList();

    if (currentUser && fbDb) {
        updateSyncStatus("同期中...", true);
        if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
        var delay = debounceCloud ? 150 : 0;
        cloudSaveTimer = setTimeout(function() {
            pushLocalToCloud(newText, now);
        }, delay);
    }
}

function pushLocalToCloud(textToSave, clientTime) {
    if (!currentUser || !fbDb) return Promise.resolve();
    return fbDb.ref("users/" + currentUser.uid).set({
        bulkText: textToSave,
        clientUpdatedAt: clientTime || Date.now(),
        updatedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(function() {
        if ((localStorage.getItem("kuji_bulk_text") || "") === textToSave) {
            localStorage.removeItem("kuji_pending_sync");
        }
        updateSyncStatus("同期済み", true);
    }).catch(function(err) {
        console.error("Cloud save error:", err);
        updateSyncStatus("同期エラー", false);
    });
}

// 編集画面の内容（1行入力欄に未追加の文字がある場合も含む）をすべて統合して取得
function collectCurrentEditorText() {
    var textarea = document.getElementById("bulk-input");
    var quickInput = document.getElementById("quick-add-input");
    var baseText = textarea ? textarea.value : (localStorage.getItem("kuji_bulk_text") || "");

    if (quickInput && quickInput.value.trim()) {
        var quickRaw = quickInput.value.trim();
        baseText = baseText.trim() ? (baseText.replace(/\s+$/, "") + "\n" + quickRaw) : quickRaw;
        quickInput.value = "";
        if (textarea) {
            textarea.value = baseText;
            textarea.scrollTop = textarea.scrollHeight;
        }
        var targetTab = /[:：\t]/.test(quickRaw) ? "has" : "none";
        sessionStorage.setItem("kuji_filter_tab", targetTab);
    }
    return baseText;
}

// 「保存する」ボタンによる明示的保存
function saveEditorExplicit() {
    var finalText = collectCurrentEditorText();
    if (cloudSaveTimer) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = null;
    }
    saveBulkText(finalText, false);
    updateWordCountBadge(wordList.length);

    var feedback = document.getElementById("save-feedback");
    if (feedback) {
        feedback.textContent = "保存しました";
        feedback.classList.add("visible");
        setTimeout(function() {
            feedback.classList.remove("visible");
        }, 2000);
    }
}

// 編集画面から「一覧に戻る」を押したときに未送信データを確実に保存してから遷移
function returnToIndex(event) {
    var finalText = collectCurrentEditorText();
    localStorage.setItem("kuji_bulk_text", finalText);
    localStorage.setItem("kuji_items", finalText);
    localStorage.setItem("kuji_pending_sync", "1");
    localStorage.setItem("kuji_updated_at", String(Date.now()));

    if (cloudSaveTimer) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = null;
    }
    if (currentUser && fbDb && localStorage.getItem("kuji_pending_sync") === "1") {
        if (event) event.preventDefault();
        var done = false;
        var go = function() {
            if (done) return;
            done = true;
            window.location.href = "./index.html";
        };
        setTimeout(go, 350);
        pushLocalToCloud(finalText, Date.now()).then(go).catch(go);
    }
}

// スクロール不要の1行クイック追加（リスト最下部に追加）
function handleQuickAddKey(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        addQuickWord();
    }
}

function addQuickWord() {
    var input = document.getElementById("quick-add-input");
    if (!input) return;
    var raw = input.value.trim();
    if (!raw) return;

    var textarea = document.getElementById("bulk-input");
    var current = textarea ? textarea.value : (localStorage.getItem("kuji_bulk_text") || "");
    var newText = current.trim() ? (current.replace(/\s+$/, "") + "\n" + raw) : raw;

    saveBulkText(newText, false);
    input.value = "";

    var targetTab = /[:：\t]/.test(raw) ? "has" : "none";
    sessionStorage.setItem("kuji_filter_tab", targetTab);

    if (textarea) {
        textarea.value = newText;
        textarea.scrollTop = textarea.scrollHeight;
    }
    updateWordCountBadge(wordList.length);
    refreshUI();

    var feedback = document.getElementById("save-feedback");
    if (feedback) {
        feedback.textContent = "最下部に追加・保存しました";
        feedback.classList.add("visible");
        setTimeout(function() {
            feedback.classList.remove("visible");
        }, 2000);
    }
}

// 全体編集テキストエリアの最下部へ一発でカーソル＆スクロール移動
function jumpToBulkBottom() {
    var textarea = document.getElementById("bulk-input");
    if (!textarea) return;
    var val = textarea.value;
    if (val && !val.endsWith("\n")) {
        textarea.value = val + "\n";
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
}

// Firebase 初期化とログイン監視
function initFirebase() {
    if (typeof firebase === "undefined") return;
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        fbAuth = firebase.auth();
        fbDb = firebase.database();

        fbAuth.onAuthStateChanged(function(user) {
            currentUser = user;
            if (user) {
                updateAuthUI(user);
                startCloudSync(user);
            } else {
                if (activeDbRef) {
                    activeDbRef.off();
                    activeDbRef = null;
                }
                updateAuthUI(null);
            }
        });
    } catch (e) {
        console.error("Firebase init error:", e);
    }
}

function updateAuthUI(user) {
    var statusEl = document.getElementById("sync-status");
    var btnEl = document.getElementById("auth-btn");
    if (!statusEl || !btnEl) return;

    if (user) {
        statusEl.textContent = "同期中";
        statusEl.classList.add("synced");
        btnEl.textContent = "ログアウト";
    } else {
        statusEl.textContent = "未同期";
        statusEl.classList.remove("synced");
        btnEl.textContent = "Google同期";
    }
}

function updateSyncStatus(text, isSynced) {
    var statusEl = document.getElementById("sync-status");
    if (!statusEl) return;
    statusEl.textContent = text;
    if (isSynced) {
        statusEl.classList.add("synced");
    } else {
        statusEl.classList.remove("synced");
    }
}

function handleAuthClick() {
    if (!fbAuth) {
        alert("読み込み中です。少し待ってからもう一度お試しください。");
        return;
    }
    if (currentUser) {
        if (confirm("ログアウトしますか？\n（端末内の単語データはそのまま残ります）")) {
            fbAuth.signOut();
        }
    } else {
        var provider = new firebase.auth.GoogleAuthProvider();
        fbAuth.signInWithPopup(provider).catch(function(err) {
            if (err.code === "auth/unauthorized-domain" || err.code === "auth/operation-not-supported-in-this-environment") {
                alert("現在の開き方（file:// など）ではGoogleログインのポップアップが制限されています。\n公開URL（https://...）から開くとログインできます。");
            } else if (err.code !== "auth/popup-closed-by-user") {
                alert("ログインエラー: " + err.message);
            }
        });
    }
}

function startCloudSync(user) {
    if (!fbDb) return;
    if (activeDbRef) activeDbRef.off();

    activeDbRef = fbDb.ref("users/" + user.uid);
    activeDbRef.on("value", function(snapshot) {
        var localText = localStorage.getItem("kuji_bulk_text") || "";
        var hasPendingLocal = (localStorage.getItem("kuji_pending_sync") === "1");
        var localUpdatedAt = Number(localStorage.getItem("kuji_updated_at") || 0);

        if (snapshot.exists()) {
            var data = snapshot.val();
            var cloudText = (data && typeof data.bulkText === "string") ? data.bulkText : "";
            var cloudUpdatedAt = (data && typeof data.clientUpdatedAt === "number") ? data.clientUpdatedAt : 0;

            // スマホ等で編集直後にページ遷移して未送信データが残っている場合は、ローカルを優先してクラウドへ送信
            if (hasPendingLocal && localUpdatedAt >= cloudUpdatedAt) {
                pushLocalToCloud(localText, localUpdatedAt);
                return;
            }

            // クラウドが空でローカルにデータがある場合はローカルをクラウドへアップロード
            if (!cloudText.trim() && localText.trim()) {
                pushLocalToCloud(localText, Date.now());
                return;
            }

            if (cloudText !== localText) {
                localStorage.setItem("kuji_bulk_text", cloudText);
                localStorage.setItem("kuji_items", cloudText);
                localStorage.removeItem("kuji_pending_sync");
                syncWordList();
                refreshUI();
            }
            updateSyncStatus("同期済み", true);
        } else {
            // 初回ログイン時：現在のローカルデータをクラウドに保存
            pushLocalToCloud(localText, Date.now());
        }
    }, function(err) {
        console.error("Snapshot error:", err);
        updateSyncStatus("設定確認", false);
    });
}

// ② ユーザーが保存していた元データ（kuji_items）を絶対に失わせず最優先で復旧する
function recoverOriginalUserData() {
    var currentBulk = localStorage.getItem("kuji_bulk_text");
    var originalItems = localStorage.getItem("kuji_items");
    var oldWordsV2 = localStorage.getItem("kuji_words_v2");

    var targetText = "";

    if (currentBulk !== null && currentBulk.trim() !== "") {
        targetText = currentBulk;
    } else if (originalItems && originalItems.trim() !== "") {
        targetText = originalItems;
    } else if (oldWordsV2) {
        try {
            var parsed = JSON.parse(oldWordsV2);
            if (Array.isArray(parsed) && parsed.length > 0) {
                targetText = parsed.map(function(item) {
                    var cleanM = cleanMeaning(item.meaning);
                    return cleanM ? item.word + " : " + cleanM : item.word;
                }).join("\n");
            }
        } catch (e) {}
    }

    // 不要な注釈文字を除去して綺麗に保存
    var cleaned = targetText
        .replace(/[:：\t]\s*（意味は未登録です[^）]*）/g, "")
        .replace(/[:：\t]\s*（意味未設定）/g, "")
        .replace(/[:：\t]\s*\(意味未設定\)/g, "");

    localStorage.setItem("kuji_bulk_text", cleaned);
    localStorage.setItem("kuji_items", cleaned);
}

// 意味テキストのクリーニング補助
function cleanMeaning(str) {
    if (!str) return "";
    var s = str.trim();
    if (s.indexOf("意味は未登録です") !== -1 || 
        s === "（意味未設定）" || 
        s === "(意味未設定)" || 
        s === "（意味は未登録です。必要に応じて再登録してください）") {
        return "";
    }
    return s;
}

// ③ テキストを解析して単語リストを同期
function syncWordList() {
    var text = localStorage.getItem("kuji_bulk_text") || "";
    wordList = parseBulkText(text);
}

// ④ テキストエリアの内容を解析
function parseBulkText(text) {
    var lines = text.split("\n");
    var parsedList = [];

    lines.forEach(function(line, index) {
        var trimmed = line.trim();
        if (!trimmed) return;

        var word = trimmed;
        var meaning = "";

        // コロン（半角: または全角：）、タブで分割
        var match = trimmed.match(/^([^:：\t]+)[:：\t](.*)$/);
        if (match) {
            word = match[1].trim();
            meaning = cleanMeaning(match[2].trim());
        } else {
            word = trimmed;
            meaning = "";
        }

        parsedList.push({
            id: "word-" + index,
            word: word,
            meaning: meaning
        });
    });

    return parsedList;
}

// ⑤ 編集画面での入力イベントハンドラ
function handleBulkInput() {
    var textarea = document.getElementById("bulk-input");
    if (!textarea) return;

    saveBulkText(textarea.value, true);
    updateWordCountBadge(wordList.length);
}

function updateWordCountBadge(count) {
    var wordCountElem = document.getElementById("word-count");
    if (wordCountElem) {
        wordCountElem.innerText = count + " 件";
    }
}

// タブ切り替え（「意味あり」「意味なし」「すべて」）
function setFilterTab(tab) {
    currentFilterTab = tab;
    hasUserSelectedTab = true;
    sessionStorage.setItem("kuji_filter_tab", tab);
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function createWordCardElement(item) {
    var isEditing = (editingWordId === item.id);
    var hasMeaning = Boolean(item.meaning && item.meaning.trim() !== "");

    var card = document.createElement("div");
    card.className = isEditing ? "word-card is-editing" : "word-card";
    card.id = "card-" + item.id;

    var top = document.createElement("div");
    top.className = "word-card-top";

    var term = document.createElement("span");
    term.className = "word-term";
    term.textContent = item.word;
    top.appendChild(term);

    var actions = document.createElement("div");
    actions.className = "card-actions";

    if (!isEditing) {
        var editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = hasMeaning ? "btn-card-action" : "btn-card-action btn-card-add";
        editBtn.title = hasMeaning ? "意味を編集" : "意味を追加";
        editBtn.textContent = hasMeaning ? "編集" : "＋意味";
        editBtn.addEventListener("click", function() {
            startInlineEdit(item.id);
        });
        actions.appendChild(editBtn);
    }

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-card-action btn-card-delete";
    delBtn.title = "削除";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", function() {
        deleteWordFromText(item.word);
    });
    actions.appendChild(delBtn);

    top.appendChild(actions);
    card.appendChild(top);

    if (isEditing) {
        var editBox = document.createElement("div");
        editBox.className = "inline-edit-box";

        var input = document.createElement("input");
        input.type = "text";
        input.id = "inline-input-" + item.id;
        input.className = "inline-edit-input";
        input.placeholder = "意味・メモを入力...";
        input.value = item.meaning;
        input.addEventListener("keydown", function(event) {
            handleInlineKey(event, item.id, item.word);
        });
        editBox.appendChild(input);

        var btns = document.createElement("div");
        btns.className = "inline-edit-btns";

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-inline-cancel";
        cancelBtn.textContent = "キャンセル";
        cancelBtn.addEventListener("click", function() {
            cancelInlineEdit();
        });
        btns.appendChild(cancelBtn);

        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn-inline-save";
        saveBtn.textContent = "保存";
        saveBtn.addEventListener("click", function() {
            saveInlineMeaning(item.id, item.word);
        });
        btns.appendChild(saveBtn);

        editBox.appendChild(btns);
        card.appendChild(editBox);
    } else if (hasMeaning) {
        var desc = document.createElement("p");
        desc.className = "word-desc";
        desc.textContent = item.meaning;
        card.appendChild(desc);
    }

    return card;
}

// ⑥ 単語カード一覧の描画（意味あり・意味なしを分けて表示）
function renderWordCards(filterKeyword) {
    var container = document.getElementById("word-list");
    var filteredCountElem = document.getElementById("filtered-count");
    if (!container) return;

    var searchedList = wordList;

    if (filterKeyword && filterKeyword.trim() !== "") {
        var keyword = filterKeyword.trim().toLowerCase();
        searchedList = wordList.filter(function(item) {
            return item.word.toLowerCase().includes(keyword) || 
                   item.meaning.toLowerCase().includes(keyword);
        });
    }

    var withMeaningList = searchedList.filter(function(item) {
        return item.meaning && item.meaning.trim() !== "";
    });
    var withoutMeaningList = searchedList.filter(function(item) {
        return !item.meaning || item.meaning.trim() === "";
    });

    // 初回表示時、「意味あり」が0件で「意味なし」がある場合は自動で「意味なし」タブを選択
    if (!hasUserSelectedTab && currentFilterTab === "has" && withMeaningList.length === 0 && withoutMeaningList.length > 0) {
        currentFilterTab = "none";
    }

    // タブ件数バッジと選択状態の更新
    var countHasElem = document.getElementById("count-has-meaning");
    var countNoElem = document.getElementById("count-no-meaning");
    var countAllElem = document.getElementById("count-all");
    if (countHasElem) countHasElem.textContent = String(withMeaningList.length);
    if (countNoElem) countNoElem.textContent = String(withoutMeaningList.length);
    if (countAllElem) countAllElem.textContent = String(searchedList.length);

    var tabHas = document.getElementById("tab-has-meaning");
    var tabNo = document.getElementById("tab-no-meaning");
    var tabAll = document.getElementById("tab-all");
    if (tabHas) tabHas.classList.toggle("active", currentFilterTab === "has");
    if (tabNo) tabNo.classList.toggle("active", currentFilterTab === "none");
    if (tabAll) tabAll.classList.toggle("active", currentFilterTab === "all");

    var displayList = searchedList;
    if (currentFilterTab === "has") {
        displayList = withMeaningList;
    } else if (currentFilterTab === "none") {
        displayList = withoutMeaningList;
    }

    if (filteredCountElem) {
        filteredCountElem.innerText = displayList.length + " 件";
    }

    if (displayList.length === 0) {
        container.textContent = "";
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty-state";
        if (filterKeyword && filterKeyword.trim() !== "") {
            emptyDiv.textContent = "「" + filterKeyword + "」に一致する単語は見つかりませんでした";
        } else if (currentFilterTab === "has" && withoutMeaningList.length > 0) {
            emptyDiv.textContent = "意味が登録されている単語はまだありません（「意味なし」タブに " + withoutMeaningList.length + " 件あります）";
        } else if (currentFilterTab === "none" && withMeaningList.length > 0) {
            emptyDiv.textContent = "意味が未登録の単語はありません（すべての単語に意味がついています）";
        } else {
            emptyDiv.appendChild(document.createTextNode("登録されている単語がありません。"));
            emptyDiv.appendChild(document.createElement("br"));
            var addLink = document.createElement("a");
            addLink.href = "./edit.html";
            addLink.className = "link-add-empty";
            addLink.textContent = "単語を登録・編集";
            emptyDiv.appendChild(addLink);
        }
        container.appendChild(emptyDiv);
        return;
    }

    container.textContent = "";
    var fragment = document.createDocumentFragment();

    if (currentFilterTab === "all" && withMeaningList.length > 0 && withoutMeaningList.length > 0) {
        var headerHas = document.createElement("div");
        headerHas.className = "word-group-title";
        headerHas.textContent = "意味あり（" + withMeaningList.length + "件）";
        fragment.appendChild(headerHas);

        withMeaningList.forEach(function(item) {
            fragment.appendChild(createWordCardElement(item));
        });

        var headerNone = document.createElement("div");
        headerNone.className = "word-group-title word-group-title-spaced";
        headerNone.textContent = "意味なし（" + withoutMeaningList.length + "件）";
        fragment.appendChild(headerNone);

        withoutMeaningList.forEach(function(item) {
            fragment.appendChild(createWordCardElement(item));
        });
    } else {
        displayList.forEach(function(item) {
            fragment.appendChild(createWordCardElement(item));
        });
    }

    container.appendChild(fragment);

    if (editingWordId) {
        var editInput = document.getElementById("inline-input-" + editingWordId);
        if (editInput) {
            editInput.focus();
            editInput.select();
        }
    }
}

// ⑦ インライン編集（一覧カード上で意味を追記・編集）
function startInlineEdit(id) {
    editingWordId = id;
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function cancelInlineEdit() {
    editingWordId = null;
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function handleInlineKey(event, id, targetWord) {
    if (event.key === "Enter") {
        saveInlineMeaning(id, targetWord);
    } else if (event.key === "Escape") {
        cancelInlineEdit();
    }
}

function saveInlineMeaning(id, targetWord) {
    var editInput = document.getElementById("inline-input-" + id);
    if (!editInput) return;

    var newMeaning = cleanMeaning(editInput.value.trim());
    var text = localStorage.getItem("kuji_bulk_text") || "";
    var lines = text.split("\n");
    var updated = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();
        if (!trimmed) continue;

        var word = trimmed;
        var match = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (match) {
            word = match[1].trim();
        }

        if (word === targetWord) {
            if (newMeaning) {
                lines[i] = targetWord + " : " + newMeaning;
            } else {
                lines[i] = targetWord;
            }
            updated = true;
            break;
        }
    }

    if (updated) {
        saveBulkText(lines.join("\n"), false);
    }

    editingWordId = null;
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

// ⑧ 単語の削除
function deleteWordFromText(targetWord) {
    if (!confirm("「" + targetWord + "」を削除しますか？")) return;

    var text = localStorage.getItem("kuji_bulk_text") || "";
    var lines = text.split("\n");

    var newLines = lines.filter(function(line) {
        var trimmed = line.trim();
        if (!trimmed) return true;
        var word = trimmed;
        var match = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (match) {
            word = match[1].trim();
        }
        return word !== targetWord;
    });

    saveBulkText(newLines.join("\n"), false);

    // 編集画面の場合
    var textarea = document.getElementById("bulk-input");
    if (textarea) {
        textarea.value = newLines.join("\n");
        updateWordCountBadge(wordList.length);
    }

    // 一覧画面の場合
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

// ⑨ 検索入力
function handleSearch() {
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

// ⑩ 初期データに戻す
function resetDefaultWords() {
    if (confirm("単語一覧を初期サンプルデータに戻しますか？\n（現在の登録内容は上書きされます）")) {
        saveBulkText(DEFAULT_BULK_TEXT, false);

        var textarea = document.getElementById("bulk-input");
        if (textarea) {
            textarea.value = DEFAULT_BULK_TEXT;
            updateWordCountBadge(wordList.length);
        } else {
            renderWordCards();
        }
    }
}

// ⑪ すべてクリア
function clearAllWords() {
    if (confirm("登録されている単語をすべて消去しますか？")) {
        saveBulkText("", false);

        var textarea = document.getElementById("bulk-input");
        if (textarea) {
            textarea.value = "";
            updateWordCountBadge(0);
        } else {
            renderWordCards();
        }
    }
}

// ⑫ サブ機能: ランダムくじ引き（今日の単語）
function drawWord() {
    if (isDrawing) return;

    syncWordList();
    if (wordList.length === 0) {
        alert("単語が登録されていません。まずは「単語を登録・編集」から単語を入力してください！");
        return;
    }

    var resultBox = document.getElementById("draw-result");
    var resultWord = document.getElementById("result-word");
    var resultMeaning = document.getElementById("result-meaning");
    var drawBtn = document.getElementById("draw-btn");

    resultBox.style.display = "block";

    if (wordList.length === 1) {
        setDrawResult(wordList[0]);
        resultBox.classList.remove("popping");
        void resultBox.offsetWidth;
        resultBox.classList.add("popping");
        return;
    }

    // ルーレット演出
    isDrawing = true;
    drawBtn.disabled = true;
    resultBox.classList.remove("popping");

    var shuffleCount = 0;
    var maxShuffles = 8;
    var intervalSpeed = 50;

    var timer = setInterval(function() {
        var tempIndex = Math.floor(Math.random() * wordList.length);
        resultWord.innerText = wordList[tempIndex].word;
        resultMeaning.innerText = "";
        shuffleCount++;

        if (shuffleCount >= maxShuffles) {
            clearInterval(timer);

            var finalIndex = Math.floor(Math.random() * wordList.length);
            setDrawResult(wordList[finalIndex]);

            void resultBox.offsetWidth;
            resultBox.classList.add("popping");

            isDrawing = false;
            drawBtn.disabled = false;
        }
    }, intervalSpeed);
}

function setDrawResult(selected) {
    var resultWord = document.getElementById("result-word");
    var resultMeaning = document.getElementById("result-meaning");

    resultWord.innerText = selected.word;
    if (selected.meaning && selected.meaning.trim() !== "") {
        resultMeaning.innerText = selected.meaning;
        resultMeaning.style.display = "inline-block";
    } else {
        resultMeaning.innerText = "";
        resultMeaning.style.display = "none";
    }
}
