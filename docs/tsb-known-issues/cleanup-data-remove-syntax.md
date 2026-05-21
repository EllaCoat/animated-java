# TSB Known Issue: cleanup の `data remove` がストレージ全体を削除できない

- **ステータス**: 保留中（対応方針は EC2 側と要相談）
- **発見日**: 2026-05-21（Phase B-1 生成検証 / 実機 export → Minecraft 1.20.4 確認）
- **重大度**: 高（cleanup が機能せず、`/reload` 時に旧データが残留する）
- **発生箇所**: `src/systems/datapackCompiler/createAnimationStorageTsb.ts` の `buildCleanup`

## 症状

`buildCleanup` が生成する `<blueprint>/cleanup.mcfunction` の中身:

```mcfunction
data remove storage aj.axia:anim
data remove storage aj.axia:variants
data remove storage aj.axia:state
data remove storage aj.axia:tmp
```

Minecraft 上で各行が「無効な引数」系のエラーになり、コマンドが実行されない。

## 原因

Minecraft の `data remove` コマンドは構文上 **パスが必須**:

```
data remove (block <pos> | entity <target> | storage <target>) <path>
```

`data remove storage aj.axia:anim`（パス無し）は文法的に成立しない。
さらに **ストレージのルート（全体）を 1 コマンドで削除する手段は Minecraft に存在しない**
（`data merge` / `data get` はルートを対象にできるが、`data remove` / `data modify` はパス必須）。

## なぜ単純修正できないか

- 「既知のトップレベルキーを列挙して個別 `data remove` する」案は、
  **前バージョンの datapack に存在し現バージョンで削除されたアニメの残骸**を消せず、
  cleanup 本来の目的（`/reload` 時の旧データ汚染回避）を達成できない。
- ストレージ全体を確実に空にするには、**全データを単一の固定キー配下に置く**等の
  ストレージレイアウト変更が必要。

## 修正案

### 案 A: 単一ストレージへ集約（推奨）

全 TSB データを 1 ストレージ（例: `aj.axia:tsb`）に集約し、`anim` / `variants` /
`state` / `tmp` をトップレベルキーにする。

```mcfunction
data remove storage aj.axia:tsb anim
data remove storage aj.axia:tsb variants
data remove storage aj.axia:tsb state
data remove storage aj.axia:tsb tmp
```

各行がパスを持つ有効な `data remove` になり、トップレベルキー削除で配下を残骸ごと
一掃できるため stale data 問題も解決する。資料上のストレージ名は変わる。

### 案 B: 4 ストレージ維持 + 固定ラッパーキー

`aj.axia:anim` 等 4 ストレージを維持しつつ、各ストレージのデータを固定ラッパーキー
配下にネストする。cleanup は `data remove storage aj.axia:anim <wrapperKey>` 等 4 行。
資料上のストレージ名は残るが、全パスにラッパー段が増える。

## 影響範囲

- `createAnimationStorageTsb.ts` 内の全ストレージ参照:
  `buildCleanup` / `writeExpandFunctions` / `buildVariantsExpand` /
  `buildInitQueue` / `buildLoadTick` / `buildPop`
- 参照ドキュメント `tsb-output-sample.md` / `tsb-phase-b1-verification.md` の
  ストレージ構造記述
- Phase C（apply_frame / set_frame）のストレージ参照設計
- 現時点では Phase C 未実装のため、TSB ストレージの参照元は
  `createAnimationStorageTsb.ts` 内に閉じている → レイアウト変更の好機

## 要決定事項

案 A / 案 B のいずれを採用するか。決定後、`createAnimationStorageTsb.ts` と
参照ドキュメント、ヘッドレス生成検証テスト（`src/tests/createAnimationStorageTsb.test.ts`）
を併せて更新する。
