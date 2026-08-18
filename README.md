# じゃんけんオンライン対戦

Node.js + Socket.io によるリアルタイム対戦じゃんけんゲームです。

## ローカルで動かす

```bash
npm install
npm start
```

ブラウザで http://localhost:3000 を2つのタブ（または別の端末）で開いて対戦できます。

## 遊び方

1. 一人が「部屋を作る」を押すと4文字のコードが発行される
2. もう一人が「部屋に参加する」からそのコードを入力
3. 両者が手を選ぶと、サーバー側で同時に結果を判定・公開する
   （後出し防止のため、両者の選択がサーバーに揃うまで結果は公開されません）

## デプロイ（公開）

Render / Railway / Fly.io など、Node.jsサーバーを常時起動できるホスティングにデプロイしてください。
GitHub Pages のような静的ホスティングでは動作しません（WebSocketサーバーが必要なため）。

Renderの場合の例:
1. このフォルダをGitHubリポジトリにpush
2. Renderで「New Web Service」を選び、リポジトリを連携
3. Build Command: `npm install` / Start Command: `npm start`
4. デプロイ完了後に発行されるURLで公開
