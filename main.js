// デフォルトのお題
const DEFAULT_ITEMS = "大吉\n中吉\n小吉";

// ルーレット演出中のフラグ
let isDrawing = false;

// ① ページが開かれたときに、保存されている単語を読み込む
window.addEventListener("DOMContentLoaded", function() {
    var savedItems = localStorage.getItem("kuji_items");
    var textarea = document.getElementById("items");
    
    if (savedItems !== null && savedItems !== undefined) {
        textarea.value = savedItems;
    } else {
        textarea.value = DEFAULT_ITEMS;
        localStorage.setItem("kuji_items", DEFAULT_ITEMS);
    }
    updateItemCount();
});

// ② お題の件数を数えて表示を更新する
function updateItemCount() {
    var text = document.getElementById("items").value;
    var list = text.split("\n").filter(function(item) {
        return item.trim() !== "";
    });
    var countBadge = document.getElementById("item-count");
    if (countBadge) {
        countBadge.innerText = list.length + " 個";
    }
}

// ③ テキストエリアに入力があるたびに保存する
function saveItems() {
    var text = document.getElementById("items").value;
    localStorage.setItem("kuji_items", text);
    updateItemCount();
}

// ④ 初期値に戻す
function resetDefault() {
    if (confirm("お題を初期値（大吉・中吉・小吉）に戻しますか？")) {
        document.getElementById("items").value = DEFAULT_ITEMS;
        saveItems();
    }
}

// ⑤ お題をクリアする
function clearItems() {
    if (confirm("お題をすべて消去しますか？")) {
        document.getElementById("items").value = "";
        saveItems();
    }
}

// ⑥ くじを引く処理（パラパラと切り替わるワクワク演出付き）
function draw() {
    if (isDrawing) return;

    var text = document.getElementById("items").value;
    var list = text.split("\n").filter(function(item) {
        return item.trim() !== "";
    });

    var resultElem = document.getElementById("result");
    var drawBtn = document.getElementById("draw-btn");

    if (list.length === 0) {
        resultElem.classList.remove("popping", "roulette");
        resultElem.innerText = "単語を入力してね！";
        return;
    }

    if (list.length === 1) {
        // 候補が1つだけの場合は直接表示
        resultElem.classList.remove("popping", "roulette");
        void resultElem.offsetWidth; // リフローをトリガー
        resultElem.innerText = list[0];
        resultElem.classList.add("popping");
        return;
    }

    // 演出開始
    isDrawing = true;
    drawBtn.disabled = true;
    resultElem.classList.add("roulette");
    resultElem.classList.remove("popping");

    var shuffleCount = 0;
    var maxShuffles = 8; // パラパラ切り替わる回数
    var intervalSpeed = 50; // 切り替え間隔 (ms)

    var timer = setInterval(function() {
        var tempIndex = Math.floor(Math.random() * list.length);
        resultElem.innerText = list[tempIndex];
        shuffleCount++;

        if (shuffleCount >= maxShuffles) {
            clearInterval(timer);
            // 最終的な当選結果を決定
            var finalIndex = Math.floor(Math.random() * list.length);
            resultElem.innerText = list[finalIndex];
            resultElem.classList.remove("roulette");
            
            // ポップアニメーションをトリガー
            void resultElem.offsetWidth;
            resultElem.classList.add("popping");

            isDrawing = false;
            drawBtn.disabled = false;
        }
    }, intervalSpeed);
}