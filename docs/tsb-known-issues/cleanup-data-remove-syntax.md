# TSB Known Issue: cleanup の `data remove` がストレージ全体を削除できない

- **ステータス**: 解決済 (案 B + 空ストレージ対応ガード, 2026-05-22 実装)
- **発見日**: 2026-05-21（Phase B-1 生成検証 / 実機 export → Minecraft 1.20.4 確認）
- **重大度**: 高（cleanup が機能せず、`/reload` 時に旧データが残留する）
- **発生箇所**: `src/systems/datapackCompiler/createAnimationStorageTsb.ts` の `buildCleanup`

## 採用案と理由

**案 B (固定ラッパー段 `d` + 4 ストレージ維持) を採用**。 ラッパー名は `d` (data の意、 1 バイト)。

選定理由:

- 案 A (単一ストレージ集約) は全 path の prefix が長くなり、 また各ストレージの意味的分離 (anim / variants / state / tmp) が失われる
- ユーザー案 (登録時に key を保管 → cleanup 時に key 一致で remove) は registry 自体の整合性管理が必要で、 旧 datapack の残骸を確実に消す保証が壊れやすい
- Minecraft デコンパイル調査結果 (`CompoundTag.remove` / `NbtPathArgument.CompoundChildNode.removeTag`) より、 ラッパー段 1 段の追加は **HashMap.remove 1 回 ≈ O(1)** + マクロ path +1 段 (各ノード HashMap.get O(1)) で実質ゼロコスト

## 追加対応: 空ストレージ対応ガード

`data remove storage <ns> <path>` は対象が存在しないと `ERROR_MERGE_UNCHANGED` を throw する仕様 (`DataCommands.removeData` line 320-322)。 reload 初回は `d` キーが未作成 → 4 件のエラーログが出る。

回避のため、 cleanup の各行を `execute if data storage ... d run data remove storage ... d` でガードする。 これにより初回 reload も含めて常に無警告で cleanup 完走する。

## 実装結果

`createAnimationStorageTsb.ts` の生成内容 (例: blueprint `aj:axia`):

```mcfunction
execute if data storage aj.axia:anim d run data remove storage aj.axia:anim d
execute if data storage aj.axia:variants d run data remove storage aj.axia:variants d
execute if data storage aj.axia:state d run data remove storage aj.axia:state d
execute if data storage aj.axia:tmp d run data remove storage aj.axia:tmp d
```

全 expand / pop / dispatch / init_queue / tick の storage path 先頭に `d.` プレフィクスを挿入し、 dispatch は `with storage <ns>:tmp d` で `d` 配下を with source に指定。 詳細は `tsb-output-sample.md` 参照。

---

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

## 要決定事項 (解決済)

案 B (固定ラッパー段 `d`) + `execute if data` ガードで確定。 `createAnimationStorageTsb.ts` /
参照ドキュメント / ヘッドレス生成検証テスト (`src/tests/createAnimationStorageTsb.test.ts`)
を一括更新し、 vitest 4 ケース全通過確認済 (2026-05-22)。
