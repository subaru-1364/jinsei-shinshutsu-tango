// 初期サンプルテキスト（単語中心のシンプルな例）
const DEFAULT_BULK_TEXT = `大吉 : 最高の運勢。すべて順調に進む兆し。
中吉
小吉
イノベーション : 新しい技術や発想を取り入れた革新のこと。
アイディア`;

let wordList = [];
let isDrawing = false;
let editingWordId = null;

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
    localStorage.setItem("kuji_bulk_text", newText);
    localStorage.setItem("kuji_items", newText);
    syncWordList();

    if (currentUser && fbDb) {
        updateSyncStatus("同期中...", true);
        if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
        var delay = debounceCloud ? 600 : 0;
        cloudSaveTimer = setTimeout(function() {
            fbDb.ref("users/" + currentUser.uid).set({
                bulkText: newText,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            }).then(function() {
                updateSyncStatus("同期済み", true);
            }).catch(function(err) {
                console.error("Cloud save error:", err);
                updateSyncStatus("同期エラー", false);
            });
        }, delay);
    }
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
        if (snapshot.exists()) {
            var data = snapshot.val();
            var cloudText = (data && typeof data.bulkText === "string") ? data.bulkText : "";

            // クラウドが空でローカルにデータがある場合はローカルをクラウドへアップロード
            if (!cloudText.trim() && localText.trim()) {
                saveBulkText(localText, false);
                return;
            }

            if (cloudText !== localText) {
                localStorage.setItem("kuji_bulk_text", cloudText);
                localStorage.setItem("kuji_items", cloudText);
                syncWordList();
                refreshUI();
            }
            updateSyncStatus("同期済み", true);
        } else {
            // 初回ログイン時：現在のローカルデータをクラウドに保存
            saveBulkText(localText, false);
        }
    }, function(err) {
        console.error("Snapshot error:", err);
        updateSyncStatus("設定確認", false);
    });
}

// ② ユーザーが保存していた元データ（kuji_items）を絶対に失わせず最優先で復旧する
function recoverOriginalUserData() {
    var originalItems = localStorage.getItem("kuji_items");
    var currentBulk = localStorage.getItem("kuji_bulk_text");
    var oldWordsV2 = localStorage.getItem("kuji_words_v2");

    var targetText = "";

    // ユーザーが以前から入力していた元データ（kuji_items）を最優先で確認
    if (originalItems && originalItems.trim() !== "") {
        // currentBulk がサンプルデータ、または空なら即座に元データで上書き復旧
        if (!currentBulk || currentBulk.includes("イノベーション") || currentBulk.trim() === "大吉\n中吉\n小吉") {
            targetText = originalItems;
        } else {
            targetText = currentBulk;
        }
    } else if (currentBulk && currentBulk.trim() !== "") {
        targetText = currentBulk;
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
    // 元データキーも絶対に消さずに保護・同期保持
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

// ⑥ 単語カード一覧の描画（意味がない単語はスッキリ単語のみ表示）
function renderWordCards(filterKeyword) {
    var container = document.getElementById("word-list");
    var filteredCountElem = document.getElementById("filtered-count");
    if (!container) return;

    var displayList = wordList;

    if (filterKeyword && filterKeyword.trim() !== "") {
        var keyword = filterKeyword.trim().toLowerCase();
        displayList = wordList.filter(function(item) {
            return item.word.toLowerCase().includes(keyword) || 
                   item.meaning.toLowerCase().includes(keyword);
        });
    }

    if (filteredCountElem) {
        filteredCountElem.innerText = displayList.length + " 件";
    }

    if (displayList.length === 0) {
        container.textContent = "";
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty-state";
        if (filterKeyword) {
            emptyDiv.textContent = "「" + filterKeyword + "」に一致する単語は見つかりませんでした";
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

    displayList.forEach(function(item) {
        var isEditing = (editingWordId === item.id);
        var hasMeaning = (item.meaning && item.meaning.trim() !== "");

        var card = document.createElement("div");
        card.className = "word-card";
        card.id = "card-" + item.id;

        var top = document.createElement("div");
        top.className = "word-card-top";

        var term = document.createElement("span");
        term.className = "word-term";
        term.textContent = item.word;
        top.appendChild(term);

        var actions = document.createElement("div");
        actions.className = "card-actions";

        if (hasMeaning && !isEditing) {
            var editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "btn-card-action";
            editBtn.title = "編集";
            editBtn.textContent = "編集";
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
        } else {
            var footer = document.createElement("div");
            footer.className = "word-card-footer";

            var addMeaningBtn = document.createElement("button");
            addMeaningBtn.type = "button";
            addMeaningBtn.className = "btn-add-meaning";
            addMeaningBtn.textContent = "＋ 意味を追加";
            addMeaningBtn.addEventListener("click", function() {
                startInlineEdit(item.id);
            });
            footer.appendChild(addMeaningBtn);
            card.appendChild(footer);
        }

        fragment.appendChild(card);
    });

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
