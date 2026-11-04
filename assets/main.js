// 初期サンプルテキスト
const DEFAULT_BULK_TEXT = `大吉 : 最高の運勢。すべて順調に進む兆し。
中吉
小吉
イノベーション : 新しい技術や発想を取り入れた革新のこと。
アイディア`;

let wordList = [];
let bookList = []; // [{ id, isbn, title, author }]
let sheetLines = { uncategorized: [] }; // bookId -> array of raw lines

// 表示中の本タブ:
// index.html では "all_books", "uncategorized", または book.id
// edit.html では "uncategorized" または book.id（1枚の巨大シートではなく本ごとのシートで管理）
let currentBookTab = sessionStorage.getItem("kuji_book_tab") || "all_books";
let currentFilterTab = sessionStorage.getItem("kuji_filter_tab") || "has";
let hasUserSelectedTab = Boolean(sessionStorage.getItem("kuji_filter_tab"));

let isDrawing = false;
let editingWordId = null;

// 重複なしランダム抽選（山札シャッフル方式）用
let drawDeck = [];
let lastDrawnKey = null;
let lastPoolSignature = "";

// 辞書候補キャッシュ (word -> [candidate1, candidate2, ...])
let meaningCandidatesCache = {};
let candidateCycleIndex = {};
let bookCoverCache = {}; // isbn -> coverUrl

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

function isEditPage() {
    return Boolean(document.getElementById("bulk-input"));
}

function getEffectiveBookIdForEdit() {
    if (currentBookTab === "all_books") {
        return "uncategorized";
    }
    var exists = bookList.some(function(b) { return b.id === currentBookTab; });
    return exists ? currentBookTab : "uncategorized";
}

// ① ページ読み込み時の初期化
window.addEventListener("DOMContentLoaded", function() {
    recoverOriginalUserData();
    syncWordList();
    initFirebase();
});

function setGateVisibility(isLoggedIn, messageText, showButton) {
    var gate = document.getElementById("login-gate");
    var main = document.getElementById("app-main");
    var gateMsg = document.getElementById("gate-message");
    var gateBtn = document.getElementById("gate-login-btn");

    if (gate && main) {
        gate.style.display = isLoggedIn ? "none" : "flex";
        main.style.display = isLoggedIn ? "flex" : "none";
    }
    if (gateMsg && messageText) {
        gateMsg.textContent = messageText;
    }
    if (gateBtn) {
        gateBtn.style.display = showButton ? "inline-flex" : "none";
    }
}

function refreshUI() {
    renderBookTabs();
    renderActiveBookMeta();

    // 編集画面（edit.html）の場合：選択中の本（または未分類）のシートだけを表示
    var textarea = document.getElementById("bulk-input");
    if (textarea) {
        var editBookId = getEffectiveBookIdForEdit();
        var sheetText = (sheetLines[editBookId] || []).join("\n");
        if (document.activeElement !== textarea || textarea.value !== sheetText) {
            textarea.value = sheetText;
        }
        var sheetTitleElem = document.getElementById("editor-sheet-title");
        if (sheetTitleElem) {
            var bTitle = getBookTitleById(editBookId);
            sheetTitleElem.textContent = "「" + bTitle + "」シートの編集（単語 : 意味）";
        }
        var sheetWords = wordList.filter(function(w) { return w.bookId === editBookId; });
        updateWordCountBadge(sheetWords.length);
    }

    // 一覧画面（index.html）の場合
    var wordListContainer = document.getElementById("word-list");
    if (wordListContainer) {
        var searchInput = document.getElementById("search-input");
        var keyword = searchInput ? searchInput.value : "";
        renderWordCards(keyword);
        updateDrawDeckInfo();
    }
}

function getBookTitleById(bookId) {
    if (!bookId || bookId === "uncategorized") return "未分類";
    if (bookId === "all_books") return "すべての本";
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === bookId) return bookList[i].title;
    }
    return "未分類";
}

function getBookById(bookId) {
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === bookId) return bookList[i];
    }
    return null;
}

// 全シート（未分類＋各書籍シート）を1つの同期テキストにシリアライズ
function serializeFullBulkData() {
    var parts = [];
    var uncat = (sheetLines["uncategorized"] || []).filter(function(l) { return l.trim() !== ""; });
    if (uncat.length > 0) {
        parts.push(uncat.join("\n"));
    }

    bookList.forEach(function(book) {
        var safeTitle = (book.title || "無題").replace(/[\|\[\]\r\n]/g, " ");
        var safeAuthor = (book.author || "").replace(/[\|\[\]\r\n]/g, " ");
        var safeIsbn = (book.isbn || "").replace(/[\|\[\]\r\n]/g, "");
        var header = "# [BOOK:" + book.id + "|" + safeIsbn + "|" + safeTitle + "|" + safeAuthor + "]";
        var bLines = (sheetLines[book.id] || []).filter(function(l) { return l.trim() !== ""; });
        if (bLines.length > 0) {
            parts.push(header + "\n" + bLines.join("\n"));
        } else {
            parts.push(header);
        }
    });

    return parts.join("\n\n");
}

// ローカル保存＋クラウド同期の一括ヘルパー
function saveAllSheets(debounceCloud) {
    var fullText = serializeFullBulkData();
    saveBulkText(fullText, debounceCloud);
}

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

// 編集画面の内容（新規追加欄に未追加の文字がある場合も含む）を現在のシートに統合
function collectCurrentSheetLines() {
    var editBookId = getEffectiveBookIdForEdit();
    var textarea = document.getElementById("bulk-input");
    var quickInput = document.getElementById("quick-add-input");

    var baseText = textarea ? textarea.value : ((sheetLines[editBookId] || []).join("\n"));

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

    sheetLines[editBookId] = baseText.split("\n").filter(function(l) { return l.trim() !== ""; });
    return baseText;
}

// 「保存する」ボタンによる明示的保存
function saveEditorExplicit() {
    collectCurrentSheetLines();
    if (cloudSaveTimer) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = null;
    }
    saveAllSheets(false);
    refreshUI();
    showSaveFeedback("保存しました");
}

function showSaveFeedback(msg) {
    var feedback = document.getElementById("save-feedback");
    if (feedback) {
        feedback.textContent = msg;
        feedback.classList.add("visible");
        setTimeout(function() {
            feedback.classList.remove("visible");
        }, 2400);
    }
}

// 編集画面から「一覧に戻る」を押したときに未送信データを確実に保存してから遷移
function returnToIndex(event) {
    collectCurrentSheetLines();
    var finalText = serializeFullBulkData();
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

// 新規追加（複数行まとめて最下部へ追加＋意味省略時は辞書から自動取得）
function addQuickWord() {
    var input = document.getElementById("quick-add-input");
    if (!input) return;
    var raw = input.value.trim();
    if (!raw) return;

    var editBookId = getEffectiveBookIdForEdit();
    var textarea = document.getElementById("bulk-input");
    var current = textarea ? textarea.value : ((sheetLines[editBookId] || []).join("\n"));
    var newText = current.trim() ? (current.replace(/\s+$/, "") + "\n" + raw) : raw;

    sheetLines[editBookId] = newText.split("\n").filter(function(l) { return l.trim() !== ""; });
    input.value = "";

    var addedLines = raw.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
    var wordsNeedingAutoMeaning = [];
    addedLines.forEach(function(l) {
        if (!/[:：\t]/.test(l)) {
            wordsNeedingAutoMeaning.push(l);
        }
    });

    var targetTab = wordsNeedingAutoMeaning.length > 0 ? "none" : "has";
    sessionStorage.setItem("kuji_filter_tab", targetTab);

    saveAllSheets(false);

    if (textarea) {
        textarea.value = (sheetLines[editBookId] || []).join("\n");
        textarea.scrollTop = textarea.scrollHeight;
    }
    refreshUI();

    if (wordsNeedingAutoMeaning.length > 0) {
        showSaveFeedback("最下部に追加・辞書から意味を検索中...");
        autoFillMeaningsForSheetWords(editBookId, wordsNeedingAutoMeaning);
    } else {
        showSaveFeedback("最下部に追加・保存しました");
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

// ==================== ISBN / 本棚（書籍別シート）管理 ====================

function toggleIsbnPanel() {
    var panel = document.getElementById("isbn-panel");
    if (!panel) return;
    var isHidden = (panel.style.display === "none");
    panel.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
        var inp = document.getElementById("isbn-input");
        if (inp) inp.focus();
    }
}

function handleIsbnKey(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        addBookByIsbn();
    }
}

function normalizeIsbnInput(str) {
    if (!str) return "";
    // 全角数字・ハイフンを半角へ変換
    var half = str.replace(/[０-９]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/[－ー―‐]/g, "-");
    var digitsOnly = half.replace(/[-\s]/g, "").toUpperCase();
    if (/^\d{9}[\dX]$/.test(digitsOnly) || /^\d{13}$/.test(digitsOnly)) {
        return digitsOnly;
    }
    return "";
}

function addBookByIsbn() {
    var input = document.getElementById("isbn-input");
    var status = document.getElementById("isbn-status");
    var btn = document.getElementById("isbn-submit-btn");
    if (!input) return;

    var raw = input.value.trim();
    if (!raw) return;

    var isbn = normalizeIsbnInput(raw);
    if (!isbn) {
        // 書名として直接登録
        registerBookObject("", raw, "");
        input.value = "";
        if (status) status.textContent = "「" + raw + "」を本棚に追加しました";
        return;
    }

    // すでに同じISBNの本が登録されているかチェック
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].isbn === isbn) {
            selectBookTab(bookList[i].id);
            input.value = "";
            if (status) status.textContent = "すでに登録されている本を選択しました";
            return;
        }
    }

    if (btn) btn.disabled = true;
    if (status) status.textContent = "ISBN (" + isbn + ") から書籍情報を検索中...";

    lookupBookByIsbnApi(isbn).then(function(info) {
        if (btn) btn.disabled = false;
        if (info && info.title) {
            registerBookObject(isbn, info.title, info.author || "");
            input.value = "";
            if (status) status.textContent = "追加完了: 『" + info.title + "』";
        } else {
            var manualTitle = prompt("ISBN (" + isbn + ") の書名が自動取得できませんでした。\n本のタイトルを入力してください:", "ISBN:" + isbn);
            if (manualTitle && manualTitle.trim()) {
                registerBookObject(isbn, manualTitle.trim(), "");
                input.value = "";
                if (status) status.textContent = "追加完了: 『" + manualTitle.trim() + "』";
            } else if (status) {
                status.textContent = "書名の取得をキャンセルしました";
            }
        }
    });
}

function lookupBookByIsbnApi(isbn) {
    // すべてAPIキー不要・課金制度なしの公開エンドポイントのみを使用
    // 1. openBD API（日本の書籍メタデータ）
    // 2. Google Books 公開検索（APIキーなし・無料枠超過時もエラー返却のみで課金仕組みなし・書影に強い）
    var openBdPromise = fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn))
        .then(function(res) { return res.json(); })
        .catch(function() { return null; });

    var googleBooksPromise = fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:" + encodeURIComponent(isbn))
        .then(function(res) { return res.json(); })
        .catch(function() { return null; });

    return Promise.all([openBdPromise, googleBooksPromise]).then(function(results) {
        var openBdArr = results[0];
        var gData = results[1];

        var title = "";
        var author = "";
        var cover = "";

        if (Array.isArray(openBdArr) && openBdArr[0] && openBdArr[0].summary) {
            var s = openBdArr[0].summary;
            title = s.title || "";
            author = s.author || "";
            cover = s.cover || "";
        }

        if (gData && Array.isArray(gData.items) && gData.items[0] && gData.items[0].volumeInfo) {
            var vi = gData.items[0].volumeInfo;
            if (!title && vi.title) title = vi.title;
            if (!author && Array.isArray(vi.authors)) author = vi.authors.join(", ");
            if (!cover && vi.imageLinks) {
                var rawThumb = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || "";
                if (rawThumb) {
                    cover = rawThumb.replace(/^http:\/\//i, "https://");
                }
            }
        }

        if (!cover && isbn) {
            cover = "https://ndlsearch.ndl.go.jp/thumbnail/" + encodeURIComponent(isbn) + ".jpg";
        }

        if (cover && isbn) {
            bookCoverCache[isbn] = cover;
        }

        if (title) {
            return { title: title, author: author, cover: cover };
        }
        return null;
    });
}

function registerBookObject(isbn, title, author) {
    if (isEditPage()) {
        collectCurrentSheetLines();
    }
    var newId = "book_" + (isbn || Date.now());
    var exists = bookList.some(function(b) { return b.id === newId; });
    if (!exists) {
        bookList.push({
            id: newId,
            isbn: isbn || "",
            title: title,
            author: author || ""
        });
        if (!sheetLines[newId]) {
            sheetLines[newId] = [];
        }
    }
    currentBookTab = newId;
    sessionStorage.setItem("kuji_book_tab", newId);
    saveAllSheets(false);
    refreshUI();
}

function selectBookTab(bookId) {
    if (isEditPage()) {
        // 切り替え前に現在のシートの編集内容を保存
        collectCurrentSheetLines();
        saveAllSheets(true);
    }
    currentBookTab = bookId;
    sessionStorage.setItem("kuji_book_tab", bookId);
    refreshUI();
}

function deleteCurrentBook() {
    var targetId = isEditPage() ? getEffectiveBookIdForEdit() : currentBookTab;
    var book = getBookById(targetId);
    if (!book) return;

    var count = (sheetLines[targetId] || []).length;
    var msg = count > 0
        ? "『" + book.title + "』を本棚から削除しますか？\n（この本に登録されている " + count + " 件の単語は「未分類」へ移動して保護されます）"
        : "『" + book.title + "』を本棚から削除しますか？";
    if (!confirm(msg)) return;

    if (count > 0) {
        sheetLines["uncategorized"] = (sheetLines["uncategorized"] || []).concat(sheetLines[targetId]);
    }
    delete sheetLines[targetId];
    bookList = bookList.filter(function(b) { return b.id !== targetId; });

    currentBookTab = isEditPage() ? "uncategorized" : "all_books";
    sessionStorage.setItem("kuji_book_tab", currentBookTab);
    saveAllSheets(false);
    refreshUI();
}

function renderBookTabs() {
    var container = document.getElementById("book-tabs");
    if (!container) return;

    container.textContent = "";
    var fragment = document.createDocumentFragment();
    var editMode = isEditPage();
    var activeTabId = editMode ? getEffectiveBookIdForEdit() : currentBookTab;

    // index.html では「すべての本」タブを表示
    if (!editMode) {
        var allBtn = document.createElement("button");
        allBtn.type = "button";
        allBtn.className = (activeTabId === "all_books") ? "book-tab active" : "book-tab";
        allBtn.textContent = "すべて (" + wordList.length + ")";
        allBtn.addEventListener("click", function() {
            selectBookTab("all_books");
        });
        fragment.appendChild(allBtn);
    }

    // 「未分類」タブ
    var uncatCount = wordList.filter(function(w) { return w.bookId === "uncategorized"; }).length;
    var uncatBtn = document.createElement("button");
    uncatBtn.type = "button";
    uncatBtn.className = (activeTabId === "uncategorized") ? "book-tab active" : "book-tab";
    uncatBtn.textContent = "未分類 (" + uncatCount + ")";
    uncatBtn.addEventListener("click", function() {
        selectBookTab("uncategorized");
    });
    fragment.appendChild(uncatBtn);

    // 各書籍タブ
    bookList.forEach(function(book) {
        var bCount = wordList.filter(function(w) { return w.bookId === book.id; }).length;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = (activeTabId === book.id) ? "book-tab active" : "book-tab";
        btn.textContent = book.title + " (" + bCount + ")";
        btn.addEventListener("click", function() {
            selectBookTab(book.id);
        });
        fragment.appendChild(btn);
    });

    container.appendChild(fragment);
}

function renderActiveBookMeta() {
    var metaBox = document.getElementById("active-book-meta");
    if (!metaBox) return;

    var activeId = isEditPage() ? getEffectiveBookIdForEdit() : currentBookTab;
    var book = getBookById(activeId);
    if (!book) {
        metaBox.style.display = "none";
        metaBox.textContent = "";
        return;
    }

    metaBox.style.display = "flex";
    metaBox.textContent = "";

    var leftGroup = document.createElement("div");
    leftGroup.className = "book-meta-left";

    if (book.isbn) {
        var coverImg = document.createElement("img");
        coverImg.className = "book-cover-thumb";
        coverImg.alt = book.title;
        var ndlUrl = "https://ndlsearch.ndl.go.jp/thumbnail/" + encodeURIComponent(book.isbn) + ".jpg";
        coverImg.src = bookCoverCache[book.isbn] || ndlUrl;
        coverImg.addEventListener("error", function() {
            if (!coverImg.dataset.triedGoogle) {
                coverImg.dataset.triedGoogle = "1";
                fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:" + encodeURIComponent(book.isbn))
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                        var thumb = d && d.items && d.items[0] && d.items[0].volumeInfo &&
                                    d.items[0].volumeInfo.imageLinks &&
                                    (d.items[0].volumeInfo.imageLinks.thumbnail || d.items[0].volumeInfo.imageLinks.smallThumbnail);
                        if (thumb) {
                            var httpsThumb = thumb.replace(/^http:\/\//i, "https://");
                            bookCoverCache[book.isbn] = httpsThumb;
                            coverImg.src = httpsThumb;
                        } else {
                            coverImg.style.display = "none";
                        }
                    })
                    .catch(function() {
                        coverImg.style.display = "none";
                    });
            } else {
                coverImg.style.display = "none";
            }
        });
        leftGroup.appendChild(coverImg);
    }

    var infoSpan = document.createElement("span");
    infoSpan.className = "book-meta-text";
    var details = book.title;
    if (book.author) details += " / " + book.author;
    if (book.isbn) details += " (ISBN: " + book.isbn + ")";
    infoSpan.textContent = details;
    leftGroup.appendChild(infoSpan);

    metaBox.appendChild(leftGroup);

    var delBookBtn = document.createElement("button");
    delBookBtn.type = "button";
    delBookBtn.className = "btn-book-remove";
    delBookBtn.textContent = "本を削除";
    delBookBtn.addEventListener("click", function() {
        deleteCurrentBook();
    });
    metaBox.appendChild(delBookBtn);
}

// ==================== Wiktionary / Wikipedia 意味の自動取得 ====================

function fetchWordMeaningCandidates(word) {
    var cleanW = (word || "").trim();
    if (!cleanW) return Promise.resolve([]);
    if (meaningCandidatesCache[cleanW]) {
        return Promise.resolve(meaningCandidatesCache[cleanW]);
    }

    var candidates = [];

    // 1. Wiktionary（日本語版ウィクショナリー：国語辞典データ・完全無料・登録不要）
    var wiktUrl = "https://ja.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=" +
                  encodeURIComponent(cleanW) + "&format=json&origin=*";

    return fetch(wiktUrl)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data && data.query && data.query.pages) {
                var pages = data.query.pages;
                Object.keys(pages).forEach(function(pid) {
                    if (pid !== "-1" && pages[pid].extract) {
                        var extracted = parseWiktionaryExtract(pages[pid].extract, cleanW);
                        extracted.forEach(function(c) {
                            if (candidates.indexOf(c) === -1 && candidates.length < 4) {
                                candidates.push(c);
                            }
                        });
                    }
                });
            }
        })
        .catch(function() {})
        .then(function() {
            if (candidates.length >= 3) {
                meaningCandidatesCache[cleanW] = candidates;
                return candidates;
            }
            // 2. Wikipedia（日本語版ウィキペディア：専門用語・新語に強い・完全無料）
            var wikiUrl = "https://ja.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(cleanW);
            return fetch(wikiUrl)
                .then(function(res) {
                    if (!res.ok) return null;
                    return res.json();
                })
                .then(function(summary) {
                    if (summary && summary.extract && summary.type !== "disambiguation") {
                        var wikiDef = cleanWikipediaSummary(summary.extract);
                        if (wikiDef && candidates.indexOf(wikiDef) === -1) {
                            candidates.push(wikiDef);
                        }
                    }
                    meaningCandidatesCache[cleanW] = candidates;
                    return candidates;
                })
                .catch(function() {
                    meaningCandidatesCache[cleanW] = candidates;
                    return candidates;
                });
        });
}

function parseWiktionaryExtract(extractText, targetWord) {
    var results = [];
    var lines = extractText.split("\n");
    var skipSection = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        // 見出し判定
        if (/^=+.*=+$/.test(line)) {
            if (/発音|語源|翻訳|関連語|対義語|類義語|参照|出典|活用|派生語|成句|ことわざ/.test(line)) {
                skipSection = true;
            } else {
                skipSection = false;
            }
            continue;
        }
        if (skipSection) continue;

        // 活用形や品詞ラベルのみの行はスキップ
        if (line === targetWord || line.length < 4) continue;
        if (/^(名詞|動詞|形容詞|形容動詞|副詞|連体詞|接続詞|感動詞|日本語|編集)$/.test(line)) continue;
        if (/^\[/.test(line) || /^（.*）$/.test(line)) continue;

        var cleaned = line.replace(/^[0-9０-９]+[\.\．\s]+/, "").trim();
        if (cleaned.length >= 4 && cleaned !== targetWord) {
            if (cleaned.length > 85) {
                cleaned = cleaned.slice(0, 84) + "…";
            }
            results.push(cleaned);
            if (results.length >= 3) break;
        }
    }
    return results;
}

function cleanWikipediaSummary(extractText) {
    if (!extractText) return "";
    // 冒頭の括弧内の読み仮名・英語表記などをスッキリ整理
    var text = extractText.replace(/（[^）]{1,60}）/g, "").replace(/\([^\x29]{1,60}\)/g, "").trim();
    // 最初の1文を取り出す
    var firstSentence = text.split("。")[0];
    if (!firstSentence) return "";
    // 「〜とは、」の前の主語を省略して簡潔にする
    var match = firstSentence.match(/^.{1,30}?とは、?(.*)$/);
    if (match && match[1].trim().length >= 4) {
        firstSentence = match[1].trim();
    }
    var result = firstSentence + "。";
    if (result.length > 85) {
        result = result.slice(0, 84) + "…";
    }
    return result;
}

function autoFillMeaningsForSheetWords(bookId, wordsToFetch) {
    var uniqueWords = [];
    wordsToFetch.forEach(function(w) {
        if (uniqueWords.indexOf(w) === -1) uniqueWords.push(w);
    });

    var filledCount = 0;
    var chain = Promise.resolve();

    uniqueWords.forEach(function(targetWord) {
        chain = chain.then(function() {
            return fetchWordMeaningCandidates(targetWord).then(function(candidates) {
                if (candidates && candidates.length > 0) {
                    var applied = applyAutoMeaningToWord(bookId, targetWord, candidates[0]);
                    if (applied) filledCount++;
                }
            });
        });
    });

    chain.then(function() {
        if (filledCount > 0) {
            saveAllSheets(false);
            sessionStorage.setItem("kuji_filter_tab", "has");
            refreshUI();
            showSaveFeedback("辞書から " + filledCount + " 件の意味を自動付与しました");
        } else {
            showSaveFeedback("追加・保存しました（辞書一致なし）");
        }
    });
}

function applyAutoMeaningToWord(bookId, targetWord, candidateMeaning) {
    var lines = sheetLines[bookId] || [];
    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (trimmed === targetWord) {
            lines[i] = targetWord + " : [自動] " + candidateMeaning;
            return true;
        }
    }
    return false;
}

// 編集画面で「辞書から意味を一括補完」ボタンを押したとき
function batchFetchMissingMeanings() {
    collectCurrentSheetLines();
    var editBookId = getEffectiveBookIdForEdit();
    var lines = sheetLines[editBookId] || [];
    var missingWords = [];

    lines.forEach(function(line) {
        var trimmed = line.trim();
        if (trimmed && !/[:：\t]/.test(trimmed)) {
            missingWords.push(trimmed);
        }
    });

    if (missingWords.length === 0) {
        showSaveFeedback("意味が未登録の単語はありません");
        return;
    }

    var btn = document.getElementById("batch-dict-btn");
    if (btn) btn.disabled = true;
    showSaveFeedback(missingWords.length + " 件の意味を辞書から検索中...");

    autoFillMeaningsForSheetWords(editBookId, missingWords);
    setTimeout(function() {
        if (btn) btn.disabled = false;
    }, 1500);
}

// カード上で「✓ 確定」（自動取得された意味を確定し、[自動] ラベルを外す）
function confirmAutoMeaning(item) {
    updateSingleWordLine(item.bookId, item.word, item.word + " : " + item.meaning);
}

// カード上で「別候補」（辞書・Wikipediaの2番目・3番目の意味候補に切り替える）
function cycleAutoMeaningCandidate(item) {
    fetchWordMeaningCandidates(item.word).then(function(candidates) {
        if (!candidates || candidates.length === 0) {
            alert("「" + item.word + "」の辞書候補が見つかりませんでした。手動で編集してください。");
            return;
        }
        if (candidates.length === 1) {
            alert("辞書に登録されている候補はこの1件のみです。\n違う場合は「編集」または「意味を消す」を押してください。");
            return;
        }
        var currentIdx = candidateCycleIndex[item.word] || 0;
        var nextIdx = (currentIdx + 1) % candidates.length;
        candidateCycleIndex[item.word] = nextIdx;
        updateSingleWordLine(item.bookId, item.word, item.word + " : [自動] " + candidates[nextIdx]);
    });
}

// カード上で「意味を消す」（間違った自動意味をワンタップで消去して「意味なし」に戻す）
function clearWordMeaning(item) {
    updateSingleWordLine(item.bookId, item.word, item.word);
}

// ==================== Firebase 初期化とログイン監視（ログイン必須ゲート連動） ====================

function initFirebase() {
    if (typeof firebase === "undefined") {
        setGateVisibility(false, "ネットワーク接続を確認してください。", false);
        return;
    }
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        fbAuth = firebase.auth();
        fbDb = firebase.database();

        fbAuth.getRedirectResult().catch(function(err) {
            console.error("Redirect auth error:", err);
        });

        fbAuth.onAuthStateChanged(function(user) {
            currentUser = user;
            updateAuthUI(user);
            if (user) {
                setGateVisibility(true, "", false);
                refreshUI();
                startCloudSync(user);
            } else {
                if (activeDbRef) {
                    activeDbRef.off();
                    activeDbRef = null;
                }
                setGateVisibility(
                    false,
                    "単語帳・本棚データはGoogleアカウントでクラウド同期・保護されています。ログインして利用を開始してください。",
                    true
                );
            }
        });
    } catch (e) {
        console.error("Firebase init error:", e);
        setGateVisibility(false, "認証システムの初期化に失敗しました。", true);
    }
}

function updateAuthUI(user) {
    var statusElem = document.getElementById("sync-status");
    var btnElem = document.getElementById("auth-btn");
    if (!statusElem || !btnElem) return;

    if (user) {
        statusElem.textContent = "同期中";
        statusElem.className = "sync-status synced";
        btnElem.textContent = "ログアウト";
    } else {
        statusElem.textContent = "未ログイン";
        statusElem.className = "sync-status";
        btnElem.textContent = "ログイン";
    }
}

function updateSyncStatus(text, isSynced) {
    var statusElem = document.getElementById("sync-status");
    if (!statusElem) return;
    statusElem.textContent = text;
    statusElem.className = isSynced ? "sync-status synced" : "sync-status";
}

function handleAuthClick() {
    if (!fbAuth) {
        alert("Firebaseの読み込み中です。少し待ってから再度お試しください。");
        return;
    }
    if (currentUser) {
        if (confirm("ログアウトしますか？")) {
            fbAuth.signOut();
        }
    } else {
        var provider = new firebase.auth.GoogleAuthProvider();
        fbAuth.signInWithPopup(provider).catch(function(err) {
            if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
                fbAuth.signInWithRedirect(provider);
            } else if (err && err.code !== "auth/popup-closed-by-user") {
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

            if (hasPendingLocal && localUpdatedAt >= cloudUpdatedAt) {
                pushLocalToCloud(localText, localUpdatedAt);
                return;
            }

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
            pushLocalToCloud(localText, Date.now());
        }
    }, function(err) {
        console.error("Snapshot error:", err);
        updateSyncStatus("設定確認", false);
    });
}

// ② ユーザーが保存していた元データ（kuji_items）を最優先で復旧する
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

    var cleaned = targetText
        .replace(/[:：\t]\s*（意味は未登録です[^）]*）/g, "")
        .replace(/[:：\t]\s*（意味未設定）/g, "")
        .replace(/[:：\t]\s*\(意味未設定\)/g, "");

    localStorage.setItem("kuji_bulk_text", cleaned);
    localStorage.setItem("kuji_items", cleaned);
}

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

function isKnownMarker(str) {
    if (!str) return false;
    var s = str.trim();
    return s === "✓" || s === "✔" || s === "済" || s === "（意味不要）";
}

// ③ テキストを解析して本棚（bookList / sheetLines）と単語リスト（wordList）を同期
function syncWordList() {
    var text = localStorage.getItem("kuji_bulk_text") || "";
    parseFullBulkData(text);
}

function parseFullBulkData(text) {
    var lines = text.split("\n");
    var newBooks = [];
    var newSheets = { uncategorized: [] };
    var parsedWords = [];
    var currentBookId = "uncategorized";

    lines.forEach(function(line, index) {
        var trimmed = line.trim();
        if (!trimmed) return;

        // 書籍セクションヘッダー判定: # [BOOK:id|isbn|title|author]
        var bookMatch = trimmed.match(/^#\s*\[BOOK:([^\]]+)\]\s*$/);
        if (bookMatch) {
            var parts = bookMatch[1].split("|");
            var bId = (parts[0] || "").trim() || ("book_" + index);
            var bIsbn = (parts[1] || "").trim();
            var bTitle = (parts[2] || "").trim() || "無題の書籍";
            var bAuthor = (parts[3] || "").trim();

            if (!newSheets[bId]) {
                newSheets[bId] = [];
                newBooks.push({
                    id: bId,
                    isbn: bIsbn,
                    title: bTitle,
                    author: bAuthor
                });
            }
            currentBookId = bId;
            return;
        }

        newSheets[currentBookId].push(trimmed);

        var word = trimmed;
        var meaning = "";
        var noMeaningNeeded = false;
        var isAutoMeaning = false;

        var match = trimmed.match(/^([^:：\t]+)[:：\t](.*)$/);
        if (match) {
            word = match[1].trim();
            var rawRight = match[2].trim();
            if (isKnownMarker(rawRight)) {
                meaning = "";
                noMeaningNeeded = true;
            } else if (rawRight.indexOf("[自動]") === 0) {
                isAutoMeaning = true;
                meaning = cleanMeaning(rawRight.replace(/^\[自動\]\s*/, ""));
            } else {
                meaning = cleanMeaning(rawRight);
            }
        }

        parsedWords.push({
            id: "word-" + index,
            bookId: currentBookId,
            word: word,
            meaning: meaning,
            noMeaningNeeded: noMeaningNeeded,
            isAutoMeaning: isAutoMeaning
        });
    });

    bookList = newBooks;
    sheetLines = newSheets;
    wordList = parsedWords;

    // 選択中の本タブが存在しない場合の補正
    if (currentBookTab !== "all_books" && currentBookTab !== "uncategorized") {
        var stillExists = bookList.some(function(b) { return b.id === currentBookTab; });
        if (!stillExists) {
            currentBookTab = isEditPage() ? "uncategorized" : "all_books";
        }
    }
}

// ⑤ 編集画面での入力イベントハンドラ（現在の本シートだけを更新）
function handleBulkInput() {
    var textarea = document.getElementById("bulk-input");
    if (!textarea) return;

    var editBookId = getEffectiveBookIdForEdit();
    sheetLines[editBookId] = textarea.value.split("\n").filter(function(l) { return l.trim() !== ""; });
    saveAllSheets(true);

    var sheetWords = wordList.filter(function(w) { return w.bookId === editBookId; });
    updateWordCountBadge(sheetWords.length);
    renderBookTabs();
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
    var isCompleted = hasMeaning || Boolean(item.noMeaningNeeded);

    var card = document.createElement("div");
    card.className = isEditing ? "word-card is-editing" : "word-card";
    card.id = "card-" + item.id;

    var top = document.createElement("div");
    top.className = "word-card-top";

    var termWrap = document.createElement("div");
    termWrap.className = "word-term-wrap";

    var term = document.createElement("span");
    term.className = "word-term";
    term.textContent = item.word;
    termWrap.appendChild(term);

    // 「すべての本」表示中で書籍が設定されている場合は書名ラベルを表示
    if (currentBookTab === "all_books" && item.bookId !== "uncategorized") {
        var bookTag = document.createElement("span");
        bookTag.className = "word-book-tag";
        bookTag.textContent = getBookTitleById(item.bookId);
        termWrap.appendChild(bookTag);
    }

    top.appendChild(termWrap);

    var actions = document.createElement("div");
    actions.className = "card-actions";

    if (!isEditing) {
        if (!isCompleted) {
            // 「意味なし」カード：辞書から自動取得ボタン
            var autoBtn = document.createElement("button");
            autoBtn.type = "button";
            autoBtn.className = "btn-card-action btn-card-auto";
            autoBtn.title = "辞書（Wiktionary / Wikipedia）から意味を自動取得";
            autoBtn.textContent = "辞書取得";
            autoBtn.addEventListener("click", function() {
                autoBtn.textContent = "取得中...";
                autoBtn.disabled = true;
                fetchWordMeaningCandidates(item.word).then(function(candidates) {
                    if (candidates && candidates.length > 0) {
                        updateSingleWordLine(item.bookId, item.word, item.word + " : [自動] " + candidates[0]);
                    } else {
                        autoBtn.textContent = "該当なし";
                        setTimeout(function() {
                            startInlineEdit(item.id);
                        }, 600);
                    }
                });
            });
            actions.appendChild(autoBtn);
        }

        var editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = isCompleted ? "btn-card-action" : "btn-card-action btn-card-add";
        editBtn.title = isCompleted ? "意味を編集" : "意味を手動で追加";
        editBtn.textContent = isCompleted ? "編集" : "＋意味";
        editBtn.addEventListener("click", function() {
            startInlineEdit(item.id);
        });
        actions.appendChild(editBtn);

        if (!isCompleted) {
            var knownBtn = document.createElement("button");
            knownBtn.type = "button";
            knownBtn.className = "btn-card-action btn-card-known";
            knownBtn.title = "意味不要（分かる単語）として完了へ移動";
            knownBtn.textContent = "✓";
            knownBtn.addEventListener("click", function() {
                markWordAsKnown(item.bookId, item.word);
            });
            actions.appendChild(knownBtn);
        }
    }

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-card-action btn-card-delete";
    delBtn.title = "削除";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", function() {
        deleteWordFromSheet(item.bookId, item.word);
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
            handleInlineKey(event, item.id, item.bookId, item.word);
        });
        editBox.appendChild(input);

        var candidateBox = document.createElement("div");
        candidateBox.className = "inline-candidates";
        candidateBox.id = "inline-candidates-" + item.id;
        editBox.appendChild(candidateBox);

        var btns = document.createElement("div");
        btns.className = "inline-edit-btns";

        var dictBtn = document.createElement("button");
        dictBtn.type = "button";
        dictBtn.className = "btn-inline-dict";
        dictBtn.textContent = "辞書候補を見る";
        dictBtn.addEventListener("click", function() {
            showInlineDictionaryCandidates(item.id, item.word);
        });
        btns.appendChild(dictBtn);

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
            saveInlineMeaning(item.id, item.bookId, item.word);
        });
        btns.appendChild(saveBtn);

        editBox.appendChild(btns);
        card.appendChild(editBox);
    } else if (hasMeaning) {
        var desc = document.createElement("p");
        desc.className = "word-desc";
        if (item.isAutoMeaning) {
            var badge = document.createElement("span");
            badge.className = "auto-meaning-badge";
            badge.textContent = "自動";
            desc.appendChild(badge);
        }
        desc.appendChild(document.createTextNode(item.meaning));
        card.appendChild(desc);

        // 自動取得された意味の場合は、ワンタップで「✓確定」「別候補」「意味を消す」ができるバーを表示
        if (item.isAutoMeaning) {
            var verifyBar = document.createElement("div");
            verifyBar.className = "auto-verify-bar";

            var okBtn = document.createElement("button");
            okBtn.type = "button";
            okBtn.className = "btn-auto-verify ok";
            okBtn.textContent = "✓ この意味で確定";
            okBtn.addEventListener("click", function() {
                confirmAutoMeaning(item);
            });
            verifyBar.appendChild(okBtn);

            var nextBtn = document.createElement("button");
            nextBtn.type = "button";
            nextBtn.className = "btn-auto-verify";
            nextBtn.textContent = "別の候補";
            nextBtn.addEventListener("click", function() {
                cycleAutoMeaningCandidate(item);
            });
            verifyBar.appendChild(nextBtn);

            var clearBtn = document.createElement("button");
            clearBtn.type = "button";
            clearBtn.className = "btn-auto-verify danger";
            clearBtn.textContent = "意味だけ消す";
            clearBtn.addEventListener("click", function() {
                clearWordMeaning(item);
            });
            verifyBar.appendChild(clearBtn);

            card.appendChild(verifyBar);
        }
    }

    return card;
}

function showInlineDictionaryCandidates(id, word) {
    var box = document.getElementById("inline-candidates-" + id);
    var input = document.getElementById("inline-input-" + id);
    if (!box || !input) return;

    box.textContent = "辞書を検索中...";
    fetchWordMeaningCandidates(word).then(function(candidates) {
        box.textContent = "";
        if (!candidates || candidates.length === 0) {
            box.textContent = "辞書候補が見つかりませんでした";
            return;
        }
        candidates.forEach(function(cand, idx) {
            var chip = document.createElement("button");
            chip.type = "button";
            chip.className = "candidate-chip";
            chip.textContent = "候補" + (idx + 1) + ": " + cand;
            chip.addEventListener("click", function() {
                input.value = cand;
                input.focus();
            });
            box.appendChild(chip);
        });
    });
}

// ⑥ 単語カード一覧の描画（本棚フィルター＋意味あり・意味なし分離）
function renderWordCards(filterKeyword) {
    var container = document.getElementById("word-list");
    var filteredCountElem = document.getElementById("filtered-count");
    if (!container) return;

    // 1. 選択中の本タブで絞り込み
    var bookScopedList = wordList;
    if (currentBookTab !== "all_books") {
        bookScopedList = wordList.filter(function(item) {
            return item.bookId === currentBookTab;
        });
    }

    // 2. 検索キーワードで絞り込み
    var searchedList = bookScopedList;
    if (filterKeyword && filterKeyword.trim() !== "") {
        var keyword = filterKeyword.trim().toLowerCase();
        searchedList = bookScopedList.filter(function(item) {
            return item.word.toLowerCase().includes(keyword) || 
                   item.meaning.toLowerCase().includes(keyword);
        });
    }

    var withMeaningList = searchedList.filter(function(item) {
        return (item.meaning && item.meaning.trim() !== "") || Boolean(item.noMeaningNeeded);
    });
    var withoutMeaningList = searchedList.filter(function(item) {
        return (!item.meaning || item.meaning.trim() === "") && !item.noMeaningNeeded;
    });

    if (!hasUserSelectedTab && currentFilterTab === "has" && withMeaningList.length === 0 && withoutMeaningList.length > 0) {
        currentFilterTab = "none";
    }

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
            emptyDiv.appendChild(document.createTextNode("このシートにはまだ単語が登録されていません。"));
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

// 特定のシート内の1単語行を更新して保存・再描画する共通ヘルパー
function updateSingleWordLine(bookId, targetWord, replacementLine) {
    var targetBook = bookId || "uncategorized";
    var lines = sheetLines[targetBook] || [];
    var updated = false;

    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed) continue;

        var word = trimmed;
        var match = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (match) {
            word = match[1].trim();
        }

        if (word === targetWord) {
            lines[i] = replacementLine;
            updated = true;
            break;
        }
    }

    if (updated) {
        saveAllSheets(false);
        refreshUI();
    }
}

function markWordAsKnown(bookId, targetWord) {
    updateSingleWordLine(bookId, targetWord, targetWord + " : ✓");
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

function handleInlineKey(event, id, bookId, targetWord) {
    if (event.key === "Enter") {
        saveInlineMeaning(id, bookId, targetWord);
    } else if (event.key === "Escape") {
        cancelInlineEdit();
    }
}

function saveInlineMeaning(id, bookId, targetWord) {
    var editInput = document.getElementById("inline-input-" + id);
    if (!editInput) return;

    var newMeaning = cleanMeaning(editInput.value.trim());
    var newLine = newMeaning ? (targetWord + " : " + newMeaning) : targetWord;

    editingWordId = null;
    updateSingleWordLine(bookId, targetWord, newLine);
}

// ⑧ 単語の削除
function deleteWordFromSheet(bookId, targetWord) {
    if (!confirm("「" + targetWord + "」を削除しますか？")) return;

    var targetBook = bookId || "uncategorized";
    var lines = sheetLines[targetBook] || [];

    sheetLines[targetBook] = lines.filter(function(line) {
        var trimmed = line.trim();
        if (!trimmed) return false;
        var word = trimmed;
        var match = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (match) {
            word = match[1].trim();
        }
        return word !== targetWord;
    });

    saveAllSheets(false);
    refreshUI();
}

// ⑨ 検索入力
function handleSearch() {
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

// ⑪ 現在の本シートをクリア
function clearAllWords() {
    var editBookId = getEffectiveBookIdForEdit();
    var title = getBookTitleById(editBookId);
    if (confirm("「" + title + "」シートに登録されている単語をすべて消去しますか？")) {
        sheetLines[editBookId] = [];
        saveAllSheets(false);
        refreshUI();
    }
}

// ==================== ⑫ 重複なしランダムピックアップ（山札シャッフル方式） ====================

function getActiveDrawPool() {
    if (currentBookTab !== "all_books") {
        return wordList.filter(function(w) { return w.bookId === currentBookTab; });
    }
    return wordList;
}

function buildShuffledDeck(pool) {
    var keys = pool.map(function(item) {
        return item.bookId + "::" + item.word;
    });
    // Fisher-Yates シャッフル
    for (var i = keys.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = keys[i];
        keys[i] = keys[j];
        keys[j] = tmp;
    }
    // 山札リセット直後の1枚目が直前に引いた単語と被らないように調整
    if (keys.length > 1 && lastDrawnKey && keys[keys.length - 1] === lastDrawnKey) {
        var swapIdx = Math.floor(Math.random() * (keys.length - 1));
        var t = keys[keys.length - 1];
        keys[keys.length - 1] = keys[swapIdx];
        keys[swapIdx] = t;
    }
    return keys;
}

function syncDrawDeckWithPool(pool) {
    var sig = currentBookTab + "|" + pool.map(function(w) { return w.bookId + ":" + w.word; }).join(",");
    var validSet = {};
    pool.forEach(function(w) {
        validSet[w.bookId + "::" + w.word] = w;
    });

    if (sig !== lastPoolSignature) {
        lastPoolSignature = sig;
        drawDeck = drawDeck.filter(function(k) { return Boolean(validSet[k]); });
    } else {
        drawDeck = drawDeck.filter(function(k) { return Boolean(validSet[k]); });
    }

    if (drawDeck.length === 0 && pool.length > 0) {
        drawDeck = buildShuffledDeck(pool);
    }
}

function updateDrawDeckInfo() {
    var infoElem = document.getElementById("draw-deck-info");
    if (!infoElem) return;
    var pool = getActiveDrawPool();
    if (pool.length === 0) {
        infoElem.textContent = "";
        return;
    }
    syncDrawDeckWithPool(pool);
    infoElem.textContent = "一巡まで残り " + drawDeck.length + " / " + pool.length;
}

function drawWord() {
    if (isDrawing) return;

    syncWordList();
    var pool = getActiveDrawPool();
    if (pool.length === 0) {
        alert("このシートには単語が登録されていません。「単語を登録・編集」から単語を入力してください！");
        return;
    }

    var resultBox = document.getElementById("draw-result");
    var resultWord = document.getElementById("result-word");
    var resultMeaning = document.getElementById("result-meaning");
    var drawBtn = document.getElementById("draw-btn");

    resultBox.style.display = "block";

    if (pool.length === 1) {
        setDrawResult(pool[0]);
        resultBox.classList.remove("popping");
        void resultBox.offsetWidth;
        resultBox.classList.add("popping");
        updateDrawDeckInfo();
        return;
    }

    syncDrawDeckWithPool(pool);
    var chosenKey = drawDeck.pop();
    lastDrawnKey = chosenKey;

    var chosenItem = pool[0];
    for (var i = 0; i < pool.length; i++) {
        if ((pool[i].bookId + "::" + pool[i].word) === chosenKey) {
            chosenItem = pool[i];
            break;
        }
    }

    // ルーレット演出
    isDrawing = true;
    drawBtn.disabled = true;
    resultBox.classList.remove("popping");

    var shuffleCount = 0;
    var maxShuffles = 8;
    var intervalSpeed = 45;

    var timer = setInterval(function() {
        var tempIndex = Math.floor(Math.random() * pool.length);
        resultWord.innerText = pool[tempIndex].word;
        resultMeaning.innerText = "";
        shuffleCount++;

        if (shuffleCount >= maxShuffles) {
            clearInterval(timer);

            setDrawResult(chosenItem);
            updateDrawDeckInfo();

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
