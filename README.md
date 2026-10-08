# 家計簿

スマホ・PC両方で使えるシンプルな家計簿（GitHub Pages で動く静的サイト）。

- 月ごとの収入・支出の記録と残金の計算（累計残高も表示）
- アルバイトの勤務時間を入れると、翌月（設定で変更可）の収入に自動で計上
- 三井住友カード「あとから分割」のシミュレーション（2025年4月改定後の手数料）と、家計簿への登録
- データは自分の **非公開リポジトリ** の `data.json` に保存し、端末間で同期

## 同期のセットアップ

1. 非公開リポジトリ（例：`kakeibo-data`）を用意する
2. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** で新規作成
   - Repository access: *Only select repositories* → `kakeibo-data` のみ
   - Permissions: *Contents* を **Read and write**
3. アプリの「設定」タブでユーザー名・リポジトリ名・トークンを入力して「保存して同期」
4. スマホなど別の端末でも同じように 3 を行う

トークンはその端末のブラウザ内（localStorage）にだけ保存されます。
別端末で同時に編集しても、項目単位で新しい方が採用されて統合されます。

## 分割手数料

手数料 = 利用金額 × (100円あたり手数料 ÷ 100)。支払総額を回数で割り、端数は初回に加算。
出典: https://www.smbc-card.com/mem/revo/bunkatsu.jsp
