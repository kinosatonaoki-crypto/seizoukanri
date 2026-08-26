# 紀の里 製造予定管理アプリ

紀の里食品向け製造予定作成アプリの実装コード（フェーズ1）。
Netlify（静的サイト + Netlify Functions + Netlify Blobs）での運用を前提とした構成です。

## 構成
- `app_logic.js` — アプリ本体のロジック（画面描画・状態管理・保存処理）
- `app_style.css` — スタイルシート
- `build.js` — `app_logic.js` / `app_style.css` / マスタデータ(JSON) を1枚のHTMLに組み立てるビルドスクリプト
- `data/app_master_data.json` — 商品・グループのマスタデータ（通販520品目・卸329品目）
- `netlify/functions/state.mjs` — 保存データを読み書きするNetlify Function（`GET/POST /api/state`）
- `netlify.toml` — Netlifyのビルド／Functions設定
- `package.json` — ビルドスクリプトと依存パッケージ（`@netlify/blobs`）
- `public/index.html` — ビルド後の成果物（Netlifyが公開するファイル。手元でも `npm run build` で再生成できます）

## ビルド方法
```
npm install
npm run build
```
`public/index.html` に単一HTMLファイルが出力されます。Netlifyにデプロイする際は
このコマンドをビルドコマンドとして自動実行するよう `netlify.toml` に設定済みです。

## 保存の仕組み
- **Netlifyで運用する場合**：`netlify/functions/state.mjs` が Netlify Blobs
  （Netlifyが提供するシンプルなデータ保存機能）にアプリの状態を1件のレコードとして
  保存します。読み込みは `GET /api/state`、保存は `POST /api/state` で行います。
  2人が同時に保存しようとした場合はバージョン番号で競合を検知し、後から保存しようと
  した側には「他の方が先に保存しました」という通知を出し、最新の内容を読み込み直す
  仕組みになっています（Claude Artifactの競合検知と同じ考え方です）。
- **Claude Artifactのプレビュー内で開いた場合**（動作確認用）：従来どおり
  `window.claude.use('artifact')` でページ自身を書き換えて保存します。
- どちらの保存先も利用できない環境（単なる静的プレビューなど）で開いた場合は、
  自動的に「閲覧のみ・保存不可」の表示になり、安全側に倒れます。

## Netlifyへのデプロイ手順（初回のみ・ユーザー側の作業）
1. https://app.netlify.com にログイン（GitHubアカウントでのログインが簡単です）
2. 「Add new site」→「Import an existing project」→ GitHubを選択し、
   このリポジトリ（`kinosatonaoki-crypto/seizoukanri`）を選択
3. ビルド設定は `netlify.toml` から自動的に読み込まれます（そのままで問題ありません）
4. 「Deploy site」をクリック
5. 初回デプロイが完了すると、Netlifyが発行したURL（例: `xxxx.netlify.app`）でアプリに
   アクセスできるようになります。Netlify Blobsは追加設定なしで自動的に使えます。

以降、GitHubにコード変更をpushするたびにNetlifyが自動的に再ビルド・再デプロイします。

## フェーズ1の範囲
- 通販：週次計画／月次計画／グループ並び順／印刷プレビュー
- 卸売：週次計画／月次計画（商品別合計のみ）／印刷プレビュー
- 確定／下書きワークフロー、製造メモ＋履歴

## 未対応（フェーズ2以降の候補）
- OCR取込・スマホ撮影
- 卸売の取引先別内訳（対応表データの整備が前提）
- 前年同期・自動算出などの実績ベース予測（実績データの蓄積が前提）
- 複数人が同時に編集した際のリアルタイム同期（現状は保存時の競合検知のみ）
