// 初期サンプルテキスト（単語中心のシンプルな例）
const DEFAULT_BULK_TEXT = `大吉 : 最高の運勢。すべて順調に進む兆し。
中吉
小吉
イノベーション : 新しい技術や発想を取り入れた革新のこと。
アイディア`;

let wordList = [];
let isDrawing = false;
let editingWordId = null;

// ① ページ読み込み時の初期化
window.addEventListener("DOMContentLoaded", function() {
    initApp();
});

function initApp() {
    recoverOriginalUserData(); // ユーザーの元データを最優先で救出・復元
    syncWordList();

    // 編集画面（edit.html）の場合
    var textarea = document.getElementById("bulk-input");
    if (textarea) {
        var saved = localStorage.getItem("kuji_bulk_text") || localStorage.getItem("kuji_items") || "";
        textarea.value = saved;
        updateWordCountBadge(wordList.length);
    }

    // 一覧画面（kuji.html）の場合
    var wordListContainer = document.getElementById("word-list");
    if (wordListContainer) {
        var searchInput = document.getElementById("search-input");
        var keyword = searchInput ? searchInput.value : "";
        renderWordCards(keyword);
    }
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

    localStorage.setItem("kuji_bulk_text", textarea.value);
    syncWordList();
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
        if (filterKeyword) {
            container.innerHTML = '<div class="empty-state">「' + escapeHtml(filterKeyword) + '」に一致する単語は見つかりませんでした</div>';
        } else {
            container.innerHTML = '<div class="empty-state">登録されている単語がありません。<br><a href="./edit.html" class="link-add-empty">📝 単語を登録する</a></div>';
        }
        return;
    }

    var html = "";
    displayList.forEach(function(item) {
        var isEditing = (editingWordId === item.id);
        var hasMeaning = (item.meaning && item.meaning.trim() !== "");

        html += '<div class="word-card" id="card-' + item.id + '">';
        html += '  <div class="word-card-top">';
        html += '    <span class="word-term">' + escapeHtml(item.word) + '</span>';
        html += '    <div class="card-actions">';
        if (hasMeaning && !isEditing) {
            html += '      <button type="button" class="btn-card-action" onclick="startInlineEdit(\'' + item.id + '\')" title="意味を編集">✏️</button>';
        }
        html += '      <button type="button" class="btn-card-action btn-card-delete" onclick="deleteWordFromText(\'' + escapeJs(item.word) + '\')" title="削除">🗑️</button>';
        html += '    </div>';
        html += '  </div>';

        if (isEditing) {
            html += '  <div class="inline-edit-box">';
            html += '    <input type="text" id="inline-input-' + item.id + '" class="inline-edit-input" placeholder="意味・メモを入力..." value="' + escapeHtml(item.meaning) + '" onkeydown="handleInlineKey(event, \'' + item.id + '\', \'' + escapeJs(item.word) + '\')">';
            html += '    <div class="inline-edit-btns">';
            html += '      <button type="button" class="btn-inline-cancel" onclick="cancelInlineEdit()">キャンセル</button>';
            html += '      <button type="button" class="btn-inline-save" onclick="saveInlineMeaning(\'' + item.id + '\', \'' + escapeJs(item.word) + '\')">保存</button>';
            html += '    </div>';
            html += '  </div>';
        } else if (hasMeaning) {
            html += '  <p class="word-desc">' + escapeHtml(item.meaning) + '</p>';
        } else {
            html += '  <div class="word-card-footer">';
            html += '    <button type="button" class="btn-add-meaning" onclick="startInlineEdit(\'' + item.id + '\')">＋ 意味を追加</button>';
            html += '  </div>';
        }

        html += '</div>';
    });

    container.innerHTML = html;

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
        localStorage.setItem("kuji_bulk_text", lines.join("\n"));
        syncWordList();
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

    localStorage.setItem("kuji_bulk_text", newLines.join("\n"));
    syncWordList();

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
        localStorage.setItem("kuji_bulk_text", DEFAULT_BULK_TEXT);
        syncWordList();

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
        localStorage.setItem("kuji_bulk_text", "");
        syncWordList();

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

// 補助関数
function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeJs(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}
