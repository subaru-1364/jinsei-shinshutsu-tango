---
trigger: always_on
description: API利用方針・APIキー管理・課金防止およびセキュリティに関する必須ルール
---

# API利用・キー管理・セキュリティ規約（人生新出単語）

1. **有料API・従量課金APIの使用禁止**
   - 本プロジェクト（静的ホスティング：GitHub Pages）では、クレジットカード課金や従量課金が発生する外部APIを使用してはならない。
   - 外部連携には、**APIキー不要かつ完全無料（上限到達時もエラー返却のみで課金仕組みが存在しない）の公開エンドポイントのみ**を使用すること：
     - 書籍情報・書影取得：`openBD API`、`Google Books API（APIキーなし公開検索）`
     - 辞書・意味取得：`日本語版 Wiktionary API`、`日本語版 Wikipedia REST API`

2. **APIキーの管理方針**
   - 秘密鍵（Secret Key / 課金紐付きAPIキー）をフロントエンドのJavaScript・HTML・Gitリポジトリ内に絶対に記述・コミットしてはならない。
   - `assets/main.js` 内の `firebaseConfig.apiKey` は Firebase クライアント識別用の公開IDであり、セキュリティは以下によって担保する：
     - Firebase Authentication の「承認済みドメイン（`subaru-1364.github.io`, `localhost`）」によるオリジン制限
     - Firebase Realtime Database のセキュリティルール（`auth != null && auth.uid === $uid`）による本人データ以外の読み書き遮断
     - Firebase Sparkプラン（完全無料枠・自動課金なし）の維持

3. **XSS対策・DOM操作**
   - ユーザー入力値や外部API取得値を描画する際は、`innerHTML` を使用せず、`textContent` および `document.createElement` を使用すること。


4. **使用禁止のAPI・データ（規約上の理由）**
   - `Apple Books / iTunes Search API`：書影等の利用が「ストア商品の宣伝（公式バッジ＋商品リンク）」に限定されるため使用しない。
   - `国立国会図書館（NDL）書影API`：2026年3月31日でサービス終了のため使用しない。
   - 書影は**URL文字列のみ**保存し、画像ファイルを複製・再配布しない。
   - Wikipedia / Wiktionary / openBD / Google Books の出典表示（フッター）は削除しない。
