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

// 意味確認モーダル用キュー
let meaningConfirmQueue = [];
let meaningConfirmIndex = 0;
let meaningConfirmOnFinish = null;

function isLocalEnvironment() {
    var h = window.location.hostname;
    return h === "localhost" || h === "127.0.0.1" || window.location.protocol === "file:";
}

function shouldConfirmAutoMeaning() {
    var v = localStorage.getItem("kuji_confirm_meaning");
    return v === null ? true : (v === "1");
}

function handleConfirmSettingChange(checked) {
    localStorage.setItem("kuji_confirm_meaning", checked ? "1" : "0");
    syncConfirmToggleUI();
}

function syncConfirmToggleUI() {
    var toggle = document.getElementById("confirm-meaning-toggle");
    if (toggle) {
        toggle.checked = shouldConfirmAutoMeaning();
    }
}

function enterLocalPreviewMode() {
    sessionStorage.setItem("kuji_local_preview", "1");
    setGateVisibility(true, "", false);
    updateSyncStatus("ローカル確認中", false);
    refreshUI();
}

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
    syncConfirmToggleUI();
    if (isLocalEnvironment()) {
        // ローカル環境（localhost / file://）では待ち時間ゼロで即座に画面を表示
        enterLocalPreviewMode();
    }
    initFirebase();
});

// 画面離脱時（ブラウザバック、タブ閉じ、リンク遷移）に編集中の内容を確実に自動保存
window.addEventListener("pagehide", function() {
    if (isEditPage()) {
        collectCurrentSheetLines();
        saveAllSheets(false);
    }
});
window.addEventListener("beforeunload", function() {
    if (isEditPage()) {
        collectCurrentSheetLines();
        saveAllSheets(false);
    }
});

function setGateVisibility(isLoggedIn, messageText, showButton) {
    var gate = document.getElementById("login-gate");
    var main = document.getElementById("app-main");
    var gateMsg = document.getElementById("gate-message");
    var gateBtn = document.getElementById("gate-login-btn");
    var localBtn = document.getElementById("gate-local-btn");

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
    if (localBtn) {
        localBtn.style.display = (!isLoggedIn && isLocalEnvironment()) ? "inline-flex" : "none";
    }
}

function refreshUI() {
    syncConfirmToggleUI();
    renderBookTabs();
    renderActiveBookMeta();
    checkMilestoneBanner();

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
        var safeCover = (book.cover || "").replace(/[\|\[\]\r\n]/g, "");
        var header = "# [BOOK:" + book.id + "|" + safeIsbn + "|" + safeTitle + "|" + safeAuthor + (safeCover ? ("|" + safeCover) : "") + "]";
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
    var resultsBox = document.getElementById("isbn-search-results");
    var btn = document.getElementById("isbn-submit-btn");
    if (!input) return;

    var raw = input.value.trim();
    if (!raw) return;

    if (resultsBox) resultsBox.textContent = "";

    var isbn = normalizeIsbnInput(raw);
    if (!isbn) {
        // 書名・キーワードとしてGoogle Books公開検索を実行し、候補一覧＋「そのままシート名として作成」を表示
        if (btn) btn.disabled = true;
        if (status) status.textContent = "「" + raw + "」で本を検索中...";
        searchBooksByTitleKeyword(raw).then(function(candidates) {
            if (btn) btn.disabled = false;
            renderBookSearchCandidates(raw, candidates);
        });
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

function searchBooksByTitleKeyword(keyword) {
    var kw = (keyword || "").trim();
    if (!kw) return Promise.resolve([]);

    // 1. Google Books 公開検索（langRestrict=ja で日本語書籍を優先）
    var gbUrl = "https://www.googleapis.com/books/v1/volumes?q=" + encodeURIComponent(kw) + "&langRestrict=ja&maxResults=6";
    var gbPromise = fetch(gbUrl)
        .then(function(res) { return res.ok ? res.json() : null; })
        .then(function(data) {
            var list = [];
            if (data && Array.isArray(data.items)) {
                data.items.forEach(function(item) {
                    var vi = item.volumeInfo || {};
                    if (!vi.title) return;
                    var title = vi.title + (vi.subtitle ? (" " + vi.subtitle) : "");
                    var author = Array.isArray(vi.authors) ? vi.authors.join(", ") : "";
                    var foundIsbn = "";
                    if (Array.isArray(vi.industryIdentifiers)) {
                        vi.industryIdentifiers.forEach(function(idObj) {
                            if (idObj.type === "ISBN_13") {
                                foundIsbn = idObj.identifier;
                            } else if (idObj.type === "ISBN_10" && !foundIsbn) {
                                foundIsbn = idObj.identifier;
                            }
                        });
                    }
                    var thumb = "";
                    if (vi.imageLinks) {
                        var rawThumb = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || "";
                        if (rawThumb) {
                            thumb = rawThumb.replace(/^http:\/\//i, "https://");
                        }
                    }
                    if (thumb && foundIsbn) {
                        bookCoverCache[foundIsbn] = thumb;
                    }
                    list.push({
                        isbn: foundIsbn,
                        title: title,
                        author: author,
                        cover: thumb
                    });
                });
            }
            return list;
        })
        .catch(function() { return []; });

    // 2. Wikipedia 検索から書籍・小説ページのISBN/書誌を抽出してopenBDで裏付け取得
    var wpBookPromise = searchBookViaWikipediaAndOpenBd(kw);

    return Promise.all([wpBookPromise, gbPromise]).then(function(results) {
        var wpList = results[0] || [];
        var gbList = results[1] || [];
        var merged = [];
        var seenKey = {};

        function addBookCand(c) {
            if (!c || !c.title) return;
            var k = c.isbn ? ("isbn:" + c.isbn) : ("title:" + c.title + "|" + (c.author || ""));
            if (seenKey[k]) return;
            seenKey[k] = true;
            merged.push(c);
        }

        // Wikipedia+openBD・Google Books の候補を統合
        wpList.forEach(addBookCand);
        gbList.forEach(addBookCand);
        return merged.slice(0, 6);
    });
}

function extractIsbnsFromText(rawText) {
    var list = [];
    if (!rawText) return list;
    // ISBN2テンプレートやハイフン付き・連続のISBN-13 / ISBN-10を抽出
    var cleaned = rawText.replace(/\x7b\x7bISBN2?\|/gi, "ISBN ");
    var regex = /(?:ISBN(?:-1[03])?[:：\s]*)?(97[89][-\s0-9]{10,16}|[0-9]{9}[0-9Xx]|4-[-\s0-9]{8,12}[0-9Xx])/g;
    var m;
    while ((m = regex.exec(cleaned)) !== null) {
        var norm = normalizeIsbnInput(m[1]);
        if (norm && list.indexOf(norm) === -1) {
            list.push(norm);
        }
        if (list.length >= 4) break;
    }
    return list;
}

function searchBookViaWikipediaAndOpenBd(keyword) {
    var searchUrl = "https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
                    encodeURIComponent(keyword) + "&srlimit=5&format=json&origin=*";
    return fetch(searchUrl)
        .then(function(res) { return res.json(); })
        .then(function(sData) {
            var titles = [];
            if (sData && sData.query && Array.isArray(sData.query.search)) {
                sData.query.search.forEach(function(item) {
                    if (item.title && titles.indexOf(item.title) === -1) {
                        titles.push(item.title);
                    }
                });
            }
            if (titles.indexOf(keyword) === -1) {
                titles.unshift(keyword);
            }
            var tParam = titles.slice(0, 5).map(function(t) { return encodeURIComponent(t); }).join("|");
            var revUrl = "https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&redirects=1&titles=" +
                         tParam + "&format=json&origin=*";
            return fetch(revUrl).then(function(r) { return r.json(); });
        })
        .then(function(revData) {
            var isbns = [];
            var fallbackAuthor = "";
            var fallbackTitle = "";
            if (revData && revData.query && revData.query.pages) {
                var pages = revData.query.pages;
                Object.keys(pages).forEach(function(pid) {
                    var p = pages[pid];
                    if (pid === "-1" || !p.revisions || !p.revisions[0]) return;
                    var rev = p.revisions[0];
                    var wt = rev["*"] || (rev.slots && rev.slots.main && rev.slots.main["*"]) || "";
                    if (!wt) return;
                    // 記事内に検索キーワードが含まれているか確認
                    if (p.title !== keyword && wt.indexOf(keyword) === -1) return;

                    if (!fallbackTitle) {
                        fallbackTitle = (p.title === keyword) ? p.title : keyword;
                    }

                    // 著者パラメータ、または「（著者名）の小説」や記事タイトル自体が作家名の場合を抽出
                    var authMatch = wt.match(/\|\s*(?:著者|作者|author)\s*=\s*([^\n|]+)/);
                    if (authMatch && !fallbackAuthor) {
                        fallbackAuthor = cleanWikitextMarkup(authMatch[1]);
                    } else if (!fallbackAuthor && p.title !== keyword) {
                        // 記事が「作家」「小説家」「著作家」に関する記事である場合のみ著者候補とする（無関係な人物ページ等を誤認識しないガード）
                        var isWriterPage = /小説家|作家|文学者|著作家|随筆家/.test(wt.slice(0, 800));
                        if (isWriterPage) {
                            fallbackAuthor = p.title;
                        }
                    }

                    // キーワードが記事内に複数回登場する場合（目次＋作品リストなど）、すべての登場箇所周辺からISBNを探す
                    var searchPos = 0;
                    while (searchPos < wt.length && isbns.length < 4) {
                        var kwIdx = wt.indexOf(keyword, searchPos);
                        if (kwIdx === -1) break;
                        var lineWindow = wt.slice(Math.max(0, kwIdx - 80), kwIdx + 600);
                        var found = extractIsbnsFromText(lineWindow);
                        found.forEach(function(code) {
                            if (isbns.indexOf(code) === -1 && isbns.length < 4) {
                                isbns.push(code);
                            }
                        });
                        searchPos = kwIdx + keyword.length;
                    }

                    // もし作品単体ページ（p.title === keyword）で周辺にISBNがなかった場合はページ全体から抽出
                    if (isbns.length === 0 && p.title === keyword) {
                        var pageIsbns = extractIsbnsFromText(wt);
                        pageIsbns.forEach(function(code) {
                            if (isbns.indexOf(code) === -1 && isbns.length < 4) {
                                isbns.push(code);
                            }
                        });
                    }
                });
            }

            if (isbns.length === 0) {
                // ISBNがWikipedia本文になくても、作品記事としてヒットしていれば候補を1件返す
                if (fallbackTitle) {
                    return [{
                        isbn: "",
                        title: fallbackTitle,
                        author: fallbackAuthor,
                        cover: ""
                    }];
                }
                return [];
            }

            // 抽出したISBNをopenBD APIで一括照会して正確な書名・著者・書影を取得
            var openBdUrl = "https://api.openbd.jp/v1/get?isbn=" + isbns.join(",");
            return fetch(openBdUrl)
                .then(function(r) { return r.json(); })
                .then(function(bdArr) {
                    var out = [];
                    if (Array.isArray(bdArr)) {
                        bdArr.forEach(function(entry, idx) {
                            var code = isbns[idx];
                            if (entry && entry.summary && entry.summary.title) {
                                var s = entry.summary;
                                var cover = s.cover || "";
                                if (cover && (s.isbn || code)) {
                                    bookCoverCache[s.isbn || code] = cover;
                                }
                                out.push({
                                    isbn: s.isbn || code,
                                    title: s.title,
                                    author: s.author || fallbackAuthor,
                                    cover: cover
                                });
                            }
                        });
                    }
                    // openBDにデータがなかったISBNでも、キーワード名で候補を作成（表紙なし）
                    if (out.length === 0 && isbns[0]) {
                        out.push({
                            isbn: isbns[0],
                            title: fallbackTitle || keyword,
                            author: fallbackAuthor,
                            cover: ""
                        });
                    }
                    return out;
                });
        })
        .catch(function() { return []; });
}

function renderBookSearchCandidates(rawQuery, candidates) {
    var status = document.getElementById("isbn-status");
    var resultsBox = document.getElementById("isbn-search-results");
    var input = document.getElementById("isbn-input");
    if (!resultsBox) return;

    resultsBox.textContent = "";

    if (candidates && candidates.length > 0) {
        if (status) {
            status.textContent = "追加する本を選択してください（または下のボタンでそのままシート名として作成）：";
        }
        candidates.forEach(function(cand) {
            var row = document.createElement("button");
            row.type = "button";
            row.className = "book-search-item";

            if (cand.cover) {
                var img = document.createElement("img");
                img.className = "book-search-thumb";
                img.src = cand.cover;
                img.alt = cand.title;
                img.addEventListener("error", function() {
                    img.style.display = "none";
                });
                row.appendChild(img);
            }

            var textWrap = document.createElement("div");
            textWrap.className = "book-search-text";

            var titleSpan = document.createElement("span");
            titleSpan.className = "book-search-title";
            titleSpan.textContent = cand.title;
            textWrap.appendChild(titleSpan);

            var metaParts = [];
            if (cand.author) metaParts.push(cand.author);
            if (cand.isbn) metaParts.push("ISBN: " + cand.isbn);
            if (metaParts.length > 0) {
                var subSpan = document.createElement("span");
                subSpan.className = "book-search-sub";
                subSpan.textContent = metaParts.join(" / ");
                textWrap.appendChild(subSpan);
            }

            row.appendChild(textWrap);

            row.addEventListener("click", function() {
                registerBookObject(cand.isbn || "", cand.title, cand.author || "", cand.cover || "");
                if (input) input.value = "";
                resultsBox.textContent = "";
                if (status) status.textContent = "追加完了: 『" + cand.title + "』";
            });

            resultsBox.appendChild(row);
        });
    } else {
        if (status) {
            status.textContent = "「" + rawQuery + "」に一致する書籍データは見つかりませんでした。そのままシートとして作成できます：";
        }
    }

    // 本ではない自由なシート名としてそのまま作成するボタン
    var directBtn = document.createElement("button");
    directBtn.type = "button";
    directBtn.className = "book-search-direct";
    directBtn.textContent = "＋ 「" + rawQuery + "」という名前のシートとしてそのまま作成";
    directBtn.addEventListener("click", function() {
        registerBookObject("", rawQuery, "");
        if (input) input.value = "";
        resultsBox.textContent = "";
        if (status) status.textContent = "シート「" + rawQuery + "」を作成しました";
    });
    resultsBox.appendChild(directBtn);
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

        if (cover && isbn) {
            bookCoverCache[isbn] = cover;
        }

        if (title) {
            return { title: title, author: author, cover: cover };
        }
        return null;
    });
}

function registerBookObject(isbn, title, author, coverUrl) {
    if (isEditPage()) {
        collectCurrentSheetLines();
    }
    var newId = "book_" + (isbn || Date.now());
    var finalCover = coverUrl || (isbn ? bookCoverCache[isbn] : "") || "";
    var existingBook = null;
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === newId) {
            existingBook = bookList[i];
            break;
        }
    }
    if (!existingBook) {
        bookList.push({
            id: newId,
            isbn: isbn || "",
            title: title,
            author: author || "",
            cover: finalCover
        });
        if (!sheetLines[newId]) {
            sheetLines[newId] = [];
        }
    } else if (finalCover && !existingBook.cover) {
        existingBook.cover = finalCover;
    }
    if (finalCover) {
        bookCoverCache[newId] = finalCover;
        if (isbn) bookCoverCache[isbn] = finalCover;
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
    if (currentBookTab !== bookId) {
        currentBookTab = bookId;
        sessionStorage.setItem("kuji_book_tab", bookId);
        // タブ切り替え時は前のシートの山札をクリアして新しいプールで再構築
        drawDeck = [];
        lastPoolSignature = "";
    }
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

    function createTabButton(id, titleText, count) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = (activeTabId === id) ? "book-tab active" : "book-tab";
        btn.title = titleText + " (" + count + "件)";

        var titleSpan = document.createElement("span");
        titleSpan.className = "book-tab-title";
        titleSpan.textContent = titleText;
        btn.appendChild(titleSpan);

        var countSpan = document.createElement("span");
        countSpan.className = "book-tab-count";
        countSpan.textContent = count;
        btn.appendChild(countSpan);

        btn.addEventListener("click", function() {
            selectBookTab(id);
        });
        return btn;
    }

    // index.html では「すべての本」タブを表示
    if (!editMode) {
        fragment.appendChild(createTabButton("all_books", "すべて", wordList.length));
    }

    // 「未分類」タブ
    var uncatCount = wordList.filter(function(w) { return w.bookId === "uncategorized"; }).length;
    fragment.appendChild(createTabButton("uncategorized", "未分類", uncatCount));

    // 各書籍タブ
    bookList.forEach(function(book) {
        var bCount = wordList.filter(function(w) { return w.bookId === book.id; }).length;
        fragment.appendChild(createTabButton(book.id, book.title, bCount));
    });

    container.appendChild(fragment);
}

// ISBNから表紙画像URLのみを取得（openBD → Google Books の順。画像ファイル自体は保存しない）
function fetchCoverUrlByIsbn(isbn) {
    return fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn))
        .then(function(res) { return res.json(); })
        .then(function(arr) {
            var c = Array.isArray(arr) && arr[0] && arr[0].summary && arr[0].summary.cover;
            if (c) return c;
            return fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:" + encodeURIComponent(isbn))
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    var il = d && d.items && d.items[0] && d.items[0].volumeInfo && d.items[0].volumeInfo.imageLinks;
                    var t = il && (il.thumbnail || il.smallThumbnail);
                    return t ? t.replace(/^http:\/\//i, "https://") : "";
                });
        })
        .catch(function() { return ""; });
}

function renderActiveBookMeta() {
    var metaBox = document.getElementById("active-book-meta");
    if (!metaBox) return;

    var activeId = isEditPage() ? getEffectiveBookIdForEdit() : currentBookTab;

    // 「未分類（共通）」タブが選択されており、単語が1件以上ある場合は「別シートへ切り出す（アーカイブ）」バーを表示
    if (activeId === "uncategorized") {
        var uncatLines = sheetLines["uncategorized"] || [];
        if (uncatLines.length === 0) {
            metaBox.style.display = "none";
            metaBox.textContent = "";
            return;
        }
        metaBox.style.display = "flex";
        metaBox.textContent = "";

        var uncatLeft = document.createElement("div");
        uncatLeft.className = "book-meta-left";
        var uncatInfo = document.createElement("span");
        uncatInfo.className = "book-meta-text";
        uncatInfo.textContent = "未分類（共通）シート: " + uncatLines.length + " 件";
        uncatLeft.appendChild(uncatInfo);
        metaBox.appendChild(uncatLeft);

        var archiveBtn = document.createElement("button");
        archiveBtn.type = "button";
        archiveBtn.className = "btn-book-archive";
        archiveBtn.textContent = "別シートへ切り出す（アーカイブ）";
        archiveBtn.addEventListener("click", function() {
            archiveUncategorizedSheet();
        });
        metaBox.appendChild(archiveBtn);
        return;
    }

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

    var cachedCover = book.cover || bookCoverCache[book.id] || (book.isbn ? bookCoverCache[book.isbn] : "");
    if (cachedCover) {
        var coverImg = document.createElement("img");
        coverImg.className = "book-cover-thumb";
        coverImg.alt = book.title;
        coverImg.referrerPolicy = "no-referrer";
        coverImg.src = cachedCover;
        coverImg.addEventListener("error", function() {
            coverImg.style.display = "none";
        });
        leftGroup.appendChild(coverImg);
    } else if (book.isbn && !bookCoverCache["tried_" + book.id]) {
        // ISBNはあるが表紙URL未保存の本：openBD → Google Books の順で取得し、URL文字列のみ保存（画像自体は保存しない）
        bookCoverCache["tried_" + book.id] = "1";
        fetchCoverUrlByIsbn(book.isbn).then(function(url) {
            if (url) {
                book.cover = url;
                bookCoverCache[book.id] = url;
                bookCoverCache[book.isbn] = url;
                saveAllSheets(true);
                renderActiveBookMeta();
            }
        });
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
    delBookBtn.textContent = "シートを削除";
    delBookBtn.addEventListener("click", function() {
        deleteCurrentBook();
    });
    metaBox.appendChild(delBookBtn);
}

// 次の共通アーカイブシート名（「共通 1」「共通 2」…）を自動採番
function getNextArchiveSheetTitle() {
    var existingTitles = bookList.map(function(b) { return b.title; });
    var count = 1;
    while (existingTitles.indexOf("共通 " + count) !== -1 || existingTitles.indexOf("共通" + count) !== -1) {
        count++;
    }
    return "共通 " + count;
}

// 未分類が50単語（および50件刻みの節目：100, 150...）に達した際のお祝い＆切り出し提案バナー
function checkMilestoneBanner() {
    var banner = document.getElementById("milestone-banner");
    if (!banner) return;

    var uncatLines = sheetLines["uncategorized"] || [];
    var count = uncatLines.length;

    // 50件未満の場合は非表示
    if (count < 50) {
        banner.style.display = "none";
        banner.textContent = "";
        return;
    }

    var milestone = Math.floor(count / 50) * 50;
    var dismissed = parseInt(localStorage.getItem("kuji_dismissed_milestone") || "0", 10);
    // すでにこの節目（例: 50件時点）で「あとで」を押している場合は非表示（次回100件で再案内）
    if (dismissed >= milestone) {
        banner.style.display = "none";
        banner.textContent = "";
        return;
    }

    var targetTitle = getNextArchiveSheetTitle();

    banner.textContent = "";
    banner.style.display = "flex";

    var iconSpan = document.createElement("span");
    iconSpan.className = "milestone-icon";
    iconSpan.textContent = "🎉";
    banner.appendChild(iconSpan);

    var textDiv = document.createElement("div");
    textDiv.className = "milestone-text-wrap";

    var titleSpan = document.createElement("div");
    titleSpan.className = "milestone-title";
    titleSpan.textContent = "未分類が " + count + " 単語に達しました！";
    textDiv.appendChild(titleSpan);

    var descSpan = document.createElement("div");
    descSpan.className = "milestone-desc";
    descSpan.textContent = "「" + targetTitle + "」シートへ切り出して、未分類をすっきりリセットしますか？";
    textDiv.appendChild(descSpan);

    banner.appendChild(textDiv);

    var btnGroup = document.createElement("div");
    btnGroup.className = "milestone-btn-group";

    var archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "btn-milestone-action";
    archiveBtn.textContent = "今すぐ切り出す";
    archiveBtn.addEventListener("click", function() {
        archiveUncategorizedSheet(targetTitle);
    });
    btnGroup.appendChild(archiveBtn);

    var laterBtn = document.createElement("button");
    laterBtn.type = "button";
    laterBtn.className = "btn-milestone-later";
    laterBtn.textContent = "あとで";
    laterBtn.addEventListener("click", function() {
        localStorage.setItem("kuji_dismissed_milestone", String(milestone));
        banner.style.display = "none";
        banner.textContent = "";
    });
    btnGroup.appendChild(laterBtn);

    banner.appendChild(btnGroup);
}

// 「未分類（共通）」に溜まった単語を名前付きシート（例：「共通 1」）へ丸ごと切り出して空にする
function archiveUncategorizedSheet(customSheetName) {
    if (isEditPage()) {
        collectCurrentSheetLines();
    }
    var lines = sheetLines["uncategorized"] || [];
    if (lines.length === 0) {
        alert("未分類（共通）シートにはまだ単語がありません。");
        return;
    }

    var defaultName = customSheetName || getNextArchiveSheetTitle();
    var sheetName = prompt(
        "未分類（共通）にある " + lines.length + " 件の単語を新しいシートへ切り出します。\n" +
        "切り出し先のシート名を入力してください（切り出し後、未分類シートは0件になり新しく使い始められます）：",
        defaultName
    );
    if (!sheetName || !sheetName.trim()) return;

    var cleanTitle = sheetName.trim();
    var newId = "book_" + Date.now();
    bookList.push({
        id: newId,
        isbn: "",
        title: cleanTitle,
        author: ""
    });
    sheetLines[newId] = lines.slice();
    sheetLines["uncategorized"] = [];

    // 切り出し完了に伴い、マイルストーン無視記録をクリア
    localStorage.removeItem("kuji_dismissed_milestone");

    currentBookTab = newId;
    sessionStorage.setItem("kuji_book_tab", newId);
    saveAllSheets(false);
    refreshUI();
    showSaveFeedback("「" + cleanTitle + "」へ " + lines.length + " 件を切り出しました");
}

// ==================== Wiktionary / Wikipedia 意味の自動取得 ====================

// 「踵　かかと」「踵（かかと）」のように漢字＋読み仮名で入力された場合も分解して検索対象にする
function extractSearchTerms(rawWord) {
    var terms = [];
    var s = (rawWord || "").trim();
    if (!s) return terms;

    // 括弧内の読みや別表記を抽出（例: 踵（かかと） -> 踵, かかと）
    var parenMatches = s.match(/[（\x28]([^）\x29]+)[）\x29]/g);
    var withoutParens = s.replace(/[（\x28][^）\x29]+[）\x29]/g, " ").trim();

    // 全角・半角スペースで分割（例: 踵　かかと -> 踵, かかと）
    var parts = withoutParens.split(/[\s　]+/).filter(Boolean);
    parts.forEach(function(p) {
        if (terms.indexOf(p) === -1) terms.push(p);
    });

    if (parenMatches) {
        parenMatches.forEach(function(pm) {
            var inner = pm.slice(1, -1).trim();
            if (inner && terms.indexOf(inner) === -1) terms.push(inner);
        });
    }

    if (terms.indexOf(s) === -1) {
        terms.push(s);
    }

    return terms;
}

function fetchWiktionaryDefinitionsByTitles(titlesList, requiredReading) {
    if (!titlesList || titlesList.length === 0) return Promise.resolve([]);
    var titlesParam = titlesList.slice(0, 8).map(function(t) { return encodeURIComponent(t); }).join("|");
    var wiktRevUrl = "https://ja.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content&redirects=1&titles=" +
                     titlesParam + "&format=json&origin=*";
    var found = [];
    return fetch(wiktRevUrl)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data && data.query && data.query.pages) {
                var pages = data.query.pages;
                Object.keys(pages).forEach(function(pid) {
                    var page = pages[pid];
                    if (pid !== "-1" && page.revisions && page.revisions[0]) {
                        var rev = page.revisions[0];
                        var rawWikitext = rev["*"] || (rev.slots && rev.slots.main && rev.slots.main["*"]) || "";
                        if (rawWikitext) {
                            // 全文検索経由の場合、記事内に検索した読み（例：「ほおづえ」）が実際に含まれているか検証し、無関係な記事を除外する
                            if (requiredReading && rawWikitext.indexOf(requiredReading) === -1) {
                                return;
                            }
                            var defs = parseWiktionaryWikitext(rawWikitext, page.title || "");
                            defs.forEach(function(d) {
                                if (found.indexOf(d) === -1 && found.length < 4) {
                                    found.push(d);
                                }
                            });
                        }
                    }
                });
            }
            return found;
        })
        .catch(function() { return found; });
}

function fetchWordMeaningCandidates(word) {
    var cleanW = (word || "").trim();
    if (!cleanW) return Promise.resolve([]);
    if (meaningCandidatesCache[cleanW]) {
        return Promise.resolve(meaningCandidatesCache[cleanW]);
    }

    var searchTerms = extractSearchTerms(cleanW);
    var candidates = [];

    function addCandidate(text) {
        if (text && candidates.indexOf(text) === -1 && candidates.length < 4) {
            candidates.push(text);
        }
    }

    // 1. Wiktionary（タイトル完全一致・リダイレクト追跡のみ）
    return fetchWiktionaryDefinitionsByTitles(searchTerms, "")
        .then(function(defs) {
            defs.forEach(addCandidate);
        })
        .then(function() {
            if (candidates.length >= 2) return;
            // 2. ひらがなのみで入力された場合（例：「ほおづえ」）に限り、その読みを持つ漢字見出し語（例：「頬杖」）をWiktionaryから厳密検索
            var primaryTerm = searchTerms[0] || cleanW;
            if (!/^[ぁ-んー]{2,}$/.test(primaryTerm)) return;
            var wiktSearchUrl = "https://ja.wiktionary.org/w/api.php?action=query&list=search&srsearch=" +
                                encodeURIComponent("\"" + primaryTerm + "\"") + "&srlimit=3&format=json&origin=*";
            return fetch(wiktSearchUrl)
                .then(function(res) { return res.json(); })
                .then(function(sData) {
                    if (sData && sData.query && sData.query.search && sData.query.search.length > 0) {
                        var hitTitles = [];
                        sData.query.search.forEach(function(item) {
                            if (item.title && searchTerms.indexOf(item.title) === -1) {
                                hitTitles.push(item.title);
                            }
                        });
                        if (hitTitles.length > 0) {
                            return fetchWiktionaryDefinitionsByTitles(hitTitles, primaryTerm).then(function(moreDefs) {
                                moreDefs.forEach(addCandidate);
                            });
                        }
                    }
                })
                .catch(function() {});
        })
        .then(function() {
            if (candidates.length >= 3) {
                meaningCandidatesCache[cleanW] = candidates;
                return candidates;
            }
            // 3. Wikipedia（見出し語完全一致・公式リダイレクトのみ。無関係な記事が混ざる曖昧な全文検索は行わない）
            var wikiChain = Promise.resolve();
            searchTerms.forEach(function(term) {
                wikiChain = wikiChain.then(function() {
                    if (candidates.length >= 3) return;
                    var wikiUrl = "https://ja.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(term);
                    return fetch(wikiUrl)
                        .then(function(res) {
                            if (!res.ok) return null;
                            return res.json();
                        })
                        .then(function(summary) {
                            if (summary && summary.extract && summary.type !== "disambiguation") {
                                var wikiDef = cleanWikipediaSummary(summary.extract);
                                addCandidate(wikiDef);
                            }
                        })
                        .catch(function() {});
                });
            });
            return wikiChain.then(function() {
                meaningCandidatesCache[cleanW] = candidates;
                return candidates;
            });
        });
}

function cleanWikitextMarkup(str) {
    if (!str) return "";
    var s = str;
    // <ref>タグやHTMLコメントを除去
    s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "").replace(/<ref[^>]*\/>/gi, "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    // rubyテンプレートを漢字（かな）に変換
    s = s.replace(/\{\{ruby\|([^|\x7d]+)\|([^|\x7d]+)[^\x7d]*\}\}/gi, "$1（$2）");
    // その他のテンプレートを除去
    while (/\{\{[^\x7b\x7d]*\}\}/.test(s)) {
        s = s.replace(/\{\{[^\x7b\x7d]*\}\}/g, "");
    }
    // [[リンク先|表示名]] -> 表示名、[[リンク名]] -> リンク名
    s = s.replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, "$1");
    // 太字・斜体マークアップ除去
    s = s.replace(/'''+/g, "").replace(/''/g, "");
    // HTMLタグ除去
    s = s.replace(/<[^>]+>/g, "");
    return s.replace(/\s+/g, " ").trim();
}

function parseWiktionaryWikitext(wikitext, targetWord) {
    var results = [];
    var readings = [];
    var lines = wikitext.split("\n");
    var inMeaningSection = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        if (/^=+.*=+$/.test(line)) {
            inMeaningSection = /意義|意味|名詞|動詞|形容詞|形容動詞|副詞|成句|ことわざ/.test(line);
            continue;
        }

        // 音読み・訓読みの行があれば読み仮名として控えに取得
        if (/^\*\s*(音読み|訓読み)\s*[:：]/.test(line)) {
            var rClean = cleanWikitextMarkup(line.replace(/^\*\s*/, ""));
            if (rClean && readings.length < 2) {
                readings.push(rClean);
            }
            continue;
        }

        // Wiktionaryの定義行は「#」で始まる（「#:」「#*」「##」は例文・引用なので除外、#直後の空白有無は問わない）
        if (/^#(?![:*#])/.test(line) || (inMeaningSection && /^\*(?![:*])/.test(line))) {
            var body = line.replace(/^[#*]+\s*/, "");
            var cleaned = cleanWikitextMarkup(body);
            if (cleaned && cleaned.length >= 2 && cleaned !== targetWord) {
                if (cleaned.length > 85) {
                    cleaned = cleaned.slice(0, 84) + "…";
                }
                results.push(cleaned);
                if (results.length >= 3) break;
            }
        }
    }

    // 漢字単体で登録されていて訓読み・音読みがある場合、最初の意味の先頭に読みを補うか候補に追加
    if (readings.length > 0 && targetWord.length === 1) {
        var readingStr = "【" + readings.join(" / ") + "】";
        if (results.length > 0 && results[0].indexOf("読み") === -1) {
            results[0] = readingStr + " " + results[0];
        } else if (results.length === 0) {
            results.push(readingStr);
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
    // 「〜とは、」「〜は、」の前の主語を省略して簡潔にする
    var match = firstSentence.match(/^.{1,25}?(?:とは、?|は、)\s*(.*)$/);
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

    var foundItems = [];
    var chain = Promise.resolve();

    uniqueWords.forEach(function(targetWord) {
        chain = chain.then(function() {
            return fetchWordMeaningCandidates(targetWord).then(function(candidates) {
                if (candidates && candidates.length > 0) {
                    foundItems.push({
                        bookId: bookId,
                        word: targetWord,
                        candidates: candidates
                    });
                }
            });
        });
    });

    chain.then(function() {
        if (foundItems.length === 0) {
            showSaveFeedback("追加・保存しました（辞書一致なし）");
            return;
        }

        // 「意味を確認する」設定がONなら確認モーダルを順番に表示
        if (shouldConfirmAutoMeaning()) {
            openMeaningConfirmQueue(foundItems, function(confirmedCount) {
                saveAllSheets(false);
                if (confirmedCount > 0) {
                    sessionStorage.setItem("kuji_filter_tab", "has");
                }
                refreshUI();
                showSaveFeedback(confirmedCount + " 件の意味を確認・保存しました");
            });
        } else {
            // OFFなら確認なしで第1候補を「[自動]」ラベル付きで自動登録（カード上で後から確認・別候補変更・確定が可能）
            var filledCount = 0;
            foundItems.forEach(function(entry) {
                var ok = applyConfirmedMeaningToWord(entry.bookId, entry.word, "[自動] " + entry.candidates[0]);
                if (ok) filledCount++;
            });
            saveAllSheets(false);
            if (filledCount > 0) {
                sessionStorage.setItem("kuji_filter_tab", "has");
            }
            refreshUI();
            showSaveFeedback("辞書から " + filledCount + " 件の意味を自動登録しました");
        }
    });
}

function applyConfirmedMeaningToWord(bookId, targetWord, meaningStr) {
    var lines = sheetLines[bookId] || [];
    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        var w = trimmed;
        var m = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (m) w = m[1].trim();
        if (w === targetWord) {
            lines[i] = targetWord + " : " + meaningStr;
            return true;
        }
    }
    return false;
}

function openMeaningConfirmQueue(items, onFinish) {
    meaningConfirmQueue = items || [];
    meaningConfirmIndex = 0;
    meaningConfirmOnFinish = onFinish || null;
    meaningConfirmQueue._confirmedCount = 0;
    renderCurrentMeaningConfirmModal();
}

function renderCurrentMeaningConfirmModal() {
    var modal = document.getElementById("meaning-confirm-modal");
    if (!modal) return;

    if (meaningConfirmIndex >= meaningConfirmQueue.length) {
        modal.style.display = "none";
        var count = meaningConfirmQueue._confirmedCount || 0;
        var cb = meaningConfirmOnFinish;
        meaningConfirmQueue = [];
        meaningConfirmOnFinish = null;
        if (cb) cb(count);
        return;
    }

    var current = meaningConfirmQueue[meaningConfirmIndex];
    var badge = document.getElementById("modal-step-badge");
    var title = document.getElementById("modal-word-title");
    var list = document.getElementById("modal-candidates-list");
    var input = document.getElementById("modal-meaning-input");
    var skipBtn = document.getElementById("modal-skip-btn");

    if (badge) {
        badge.textContent = "意味の確認 (" + (meaningConfirmIndex + 1) + " / " + meaningConfirmQueue.length + ")";
    }
    if (skipBtn) {
        skipBtn.textContent = (meaningConfirmQueue.length > 1) ? "スキップ（登録しない）" : "キャンセル";
    }
    if (title) {
        title.textContent = current.word;
    }
    if (input) {
        input.value = current.candidates[0] || "";
    }
    if (list) {
        list.textContent = "";
        current.candidates.forEach(function(cand, idx) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = (idx === 0) ? "candidate-chip active" : "candidate-chip";
            btn.textContent = "候補" + (idx + 1) + ": " + cand;
            btn.addEventListener("click", function() {
                if (input) input.value = cand;
                var allChips = list.querySelectorAll(".candidate-chip");
                for (var k = 0; k < allChips.length; k++) {
                    allChips[k].classList.remove("active");
                }
                btn.classList.add("active");
            });
            list.appendChild(btn);
        });
    }

    modal.style.display = "flex";
    if (input) input.focus();
}

function resolveMeaningModal(action) {
    if (meaningConfirmIndex >= meaningConfirmQueue.length) return;
    var current = meaningConfirmQueue[meaningConfirmIndex];
    var input = document.getElementById("modal-meaning-input");
    var val = input ? input.value.trim() : (current.candidates[0] || "");

    if (action === "save" && val) {
        applyConfirmedMeaningToWord(current.bookId, current.word, val);
        meaningConfirmQueue._confirmedCount = (meaningConfirmQueue._confirmedCount || 0) + 1;
    } else if (action === "known") {
        applyConfirmedMeaningToWord(current.bookId, current.word, "✓");
        meaningConfirmQueue._confirmedCount = (meaningConfirmQueue._confirmedCount || 0) + 1;
    }

    meaningConfirmIndex++;
    renderCurrentMeaningConfirmModal();
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
            } else if (isLocalEnvironment() && sessionStorage.getItem("kuji_local_preview") === "1") {
                setGateVisibility(true, "", false);
                updateSyncStatus("ローカル確認中", false);
                refreshUI();
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

            // ① ローカルに未送信の変更がある、またはローカルの更新日時のほうが新しい場合は、ローカルを最優先保護
            if (hasPendingLocal || localUpdatedAt > cloudUpdatedAt) {
                if (localText.trim()) {
                    pushLocalToCloud(localText, localUpdatedAt || Date.now());
                }
                return;
            }

            // ② クラウドが空でローカルにデータがある場合もローカルを保護してクラウドへ送信
            if (!cloudText.trim() && localText.trim()) {
                pushLocalToCloud(localText, Date.now());
                return;
            }

            // ③ クラウドのほうが確実に新しい（cloudUpdatedAt > localUpdatedAt）場合のみローカルを更新
            if (cloudText !== localText) {
                if (cloudUpdatedAt >= localUpdatedAt) {
                    localStorage.setItem("kuji_bulk_text", cloudText);
                    localStorage.setItem("kuji_items", cloudText);
                    localStorage.setItem("kuji_updated_at", String(cloudUpdatedAt));
                    localStorage.removeItem("kuji_pending_sync");
                    syncWordList();
                    refreshUI();
                }
            } else {
                localStorage.removeItem("kuji_pending_sync");
            }
            updateSyncStatus("同期済み", true);
        } else {
            if (localText.trim()) {
                pushLocalToCloud(localText, Date.now());
            }
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

        // 書籍セクションヘッダー判定: # [BOOK:id|isbn|title|author|cover]
        var bookMatch = trimmed.match(/^#\s*\[BOOK:([^\]]+)\]\s*$/);
        if (bookMatch) {
            var parts = bookMatch[1].split("|");
            var bId = (parts[0] || "").trim() || ("book_" + index);
            var bIsbn = (parts[1] || "").trim();
            var bTitle = (parts[2] || "").trim() || "無題の書籍";
            var bAuthor = (parts[3] || "").trim();
            var bCover = (parts[4] || "").trim();
            // 過去に保存されたApple由来の表紙URL（規約上使用しない）は破棄
            if (/mzstatic\.com|apple\.com/i.test(bCover)) bCover = "";

            if (!newSheets[bId]) {
                newSheets[bId] = [];
                if (bCover) {
                    bookCoverCache[bId] = bCover;
                }
                newBooks.push({
                    id: bId,
                    isbn: bIsbn,
                    title: bTitle,
                    author: bAuthor,
                    cover: bCover
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
    term.className = "word-term word-term-editable";
    term.title = "タップして単語・意味を編集";
    term.textContent = item.word;
    term.addEventListener("click", function() {
        startInlineEdit(item.id, true);
    });
    termWrap.appendChild(term);

    // 「すべての本」表示中で書籍が設定されている場合は書名ラベルを表示（クリックでその本へ移動可能）
    if (currentBookTab === "all_books" && item.bookId !== "uncategorized") {
        var bookTag = document.createElement("button");
        bookTag.type = "button";
        bookTag.className = "word-book-tag word-book-tag-clickable";
        bookTag.title = "この本のシートへ移動";
        bookTag.textContent = getBookTitleById(item.bookId);
        bookTag.addEventListener("click", function() {
            selectBookTab(item.bookId);
        });
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
            autoBtn.textContent = "辞書";
            autoBtn.addEventListener("click", function() {
                autoBtn.textContent = "取得中...";
                autoBtn.disabled = true;
                fetchWordMeaningCandidates(item.word).then(function(candidates) {
                    if (candidates && candidates.length > 0) {
                        if (shouldConfirmAutoMeaning()) {
                            autoBtn.textContent = "辞書";
                            autoBtn.disabled = false;
                            openMeaningConfirmQueue([{
                                bookId: item.bookId,
                                word: item.word,
                                candidates: candidates
                            }], function() {
                                saveAllSheets(false);
                                refreshUI();
                            });
                        } else {
                            updateSingleWordLine(item.bookId, item.word, item.word + " : [自動] " + candidates[0]);
                        }
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
        editBtn.title = "単語や意味を編集";
        editBtn.textContent = isCompleted ? "編集" : "編集 / ＋意味";
        editBtn.addEventListener("click", function() {
            startInlineEdit(item.id, false);
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

        var wordRow = document.createElement("div");
        wordRow.className = "inline-edit-row";
        var wordLabel = document.createElement("span");
        wordLabel.className = "inline-edit-label";
        wordLabel.textContent = "単語";
        wordRow.appendChild(wordLabel);

        var wordInput = document.createElement("input");
        wordInput.type = "text";
        wordInput.id = "inline-word-input-" + item.id;
        wordInput.className = "inline-edit-input inline-word-input";
        wordInput.placeholder = "単語を入力...";
        wordInput.value = item.word;
        wordInput.addEventListener("keydown", function(event) {
            handleInlineKey(event, item.id, item.bookId, item.word, item.noMeaningNeeded);
        });
        wordRow.appendChild(wordInput);
        editBox.appendChild(wordRow);

        var meaningRow = document.createElement("div");
        meaningRow.className = "inline-edit-row";
        var meaningLabel = document.createElement("span");
        meaningLabel.className = "inline-edit-label";
        meaningLabel.textContent = "意味";
        meaningRow.appendChild(meaningLabel);

        var input = document.createElement("input");
        input.type = "text";
        input.id = "inline-input-" + item.id;
        input.className = "inline-edit-input";
        input.placeholder = "意味・メモを入力（空欄で意味なし）...";
        input.value = item.meaning;
        input.addEventListener("keydown", function(event) {
            handleInlineKey(event, item.id, item.bookId, item.word, item.noMeaningNeeded);
        });
        meaningRow.appendChild(input);
        editBox.appendChild(meaningRow);

        if (bookList.length > 0) {
            var bookRow = document.createElement("div");
            bookRow.className = "inline-edit-row";
            var bookLabel = document.createElement("span");
            bookLabel.className = "inline-edit-label";
            bookLabel.textContent = "移動";
            bookRow.appendChild(bookLabel);

            var bookSelect = document.createElement("select");
            bookSelect.id = "inline-book-select-" + item.id;
            bookSelect.className = "inline-edit-input inline-book-select";

            var uncatOpt = document.createElement("option");
            uncatOpt.value = "uncategorized";
            uncatOpt.textContent = "未分類（共通）";
            if (item.bookId === "uncategorized") uncatOpt.selected = true;
            bookSelect.appendChild(uncatOpt);

            bookList.forEach(function(b) {
                var opt = document.createElement("option");
                opt.value = b.id;
                opt.textContent = b.title;
                if (item.bookId === b.id) opt.selected = true;
                bookSelect.appendChild(opt);
            });

            bookRow.appendChild(bookSelect);
            editBox.appendChild(bookRow);
        }

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
            var currentWordVal = wordInput.value.trim() || item.word;
            showInlineDictionaryCandidates(item.id, currentWordVal);
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
            saveInlineMeaning(item.id, item.bookId, item.word, item.noMeaningNeeded);
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
        var targetInputId = editingFocusWord ? ("inline-word-input-" + editingWordId) : ("inline-input-" + editingWordId);
        var editInput = document.getElementById(targetInputId) || document.getElementById("inline-input-" + editingWordId);
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

// ⑦ インライン編集（一覧カード上で単語・意味を編集）
var editingFocusWord = false;

function startInlineEdit(id, focusWord) {
    editingWordId = id;
    editingFocusWord = Boolean(focusWord);
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function cancelInlineEdit() {
    editingWordId = null;
    editingFocusWord = false;
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function handleInlineKey(event, id, bookId, targetWord, wasNoMeaningNeeded) {
    if (event.key === "Enter") {
        saveInlineMeaning(id, bookId, targetWord, wasNoMeaningNeeded);
    } else if (event.key === "Escape") {
        cancelInlineEdit();
    }
}

function saveInlineMeaning(id, bookId, targetWord, wasNoMeaningNeeded) {
    var wordInput = document.getElementById("inline-word-input-" + id);
    var editInput = document.getElementById("inline-input-" + id);
    var bookSelect = document.getElementById("inline-book-select-" + id);
    if (!editInput) return;

    var newWord = wordInput ? wordInput.value.trim() : targetWord;
    if (!newWord) {
        alert("単語を入力してください");
        if (wordInput) wordInput.focus();
        return;
    }

    var newMeaning = cleanMeaning(editInput.value.trim());
    var newLine = newWord;
    if (newMeaning) {
        newLine = newWord + " : " + newMeaning;
    } else if (wasNoMeaningNeeded) {
        newLine = newWord + " : ✓";
    }

    var destBookId = bookSelect ? bookSelect.value : (bookId || "uncategorized");
    var sourceBookId = bookId || "uncategorized";

    editingWordId = null;
    editingFocusWord = false;

    if (destBookId !== sourceBookId) {
        // 別の本（シート）へ単語を移動する
        var srcLines = sheetLines[sourceBookId] || [];
        var removed = false;
        sheetLines[sourceBookId] = srcLines.filter(function(line) {
            if (removed) return true;
            var trimmed = line.trim();
            if (!trimmed) return false;
            var w = trimmed;
            var m = trimmed.match(/^([^:：\t]+)[:：\t]/);
            if (m) w = m[1].trim();
            if (w === targetWord) {
                removed = true;
                return false;
            }
            return true;
        });
        if (!sheetLines[destBookId]) {
            sheetLines[destBookId] = [];
        }
        sheetLines[destBookId].push(newLine);
        saveAllSheets(false);
        refreshUI();
    } else {
        updateSingleWordLine(sourceBookId, targetWord, newLine);
    }
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

    // タブ（対象シート）やプールが切り替わった場合は、山札を新しいプールの全単語で再構築
    if (sig !== lastPoolSignature) {
        lastPoolSignature = sig;
        drawDeck = buildShuffledDeck(pool);
        return;
    }

    // 同じタブ内で単語が削除・編集された場合は無効なキーを除去
    drawDeck = drawDeck.filter(function(k) { return Boolean(validSet[k]); });

    // 山札が尽きたら新しい山札をシャッフル生成（一巡完了）
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
