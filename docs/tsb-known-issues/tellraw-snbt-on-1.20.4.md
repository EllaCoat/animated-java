# TSB Known Issue: 1.20.4 ターゲットで text component が SNBT 形式で出力される

- **ステータス**: 保留中（upstream バグ、TSB Phase B-1 スコープ外）
- **発見日**: 2026-05-21（Phase B-1 生成検証 / 実機 export → Minecraft 1.20.4 確認）
- **重大度**: 中（`tellraw` を含む関数が 1.20.4 で構文エラーになる）
- **発生箇所**: `src/systems/datapackCompiler/tellraw.ts` + `book-and-quill` + `mc-build` 連携

## 症状

生成 datapack の `tellraw` 行（例: `aj:axia/zzz/summon/animation_arg/if_empty`）の
text component が以下のように出力される:

```
... "color": red ...
```

`red` がダブルクォートで囲まれていない。これは Minecraft 1.21.5+ の
**SNBT 形式の text component**。1.20.4 では text component は **JSON 必須**で、
`"color": "red"` でなければならず、SNBT はパースエラーになる。

## 原因（調査済みの範囲）

- `tellraw` 本文は `tellraw.ts` の `TELLRAW` 名前空間が `book-and-quill` の
  `TextComponent` で生成している。
- `book-and-quill` の `TextComponent.toString(minify, minecraftVersion)` は
  `minecraftVersion >= 1.21.5` で SNBT、未満で JSON を出力する
  （`node_modules/book-and-quill/dist/stringifier.js`）。
- `minecraftVersion` 省略時は静的プロパティ `TextComponent.defaultMinecraftVersion`
  （既定値 `1.21.11`）にフォールバックする。
- `src/systems/datapackCompiler/index.ts:548` で
  `TextComponent.defaultMinecraftVersion = version`（TSB export では `1.20.4`）を
  設定しているが、`mc-build` の `<%...%>` 式評価結果（`TextComponent` インスタンス）の
  文字列化にこの設定が反映されていない。
- `mc-build` が `<%...%>` の結果オブジェクトをどう文字列化しているか
  （`.toString()` 呼び出し時の引数）は未特定。ここが残課題。

## スコープ

- このバグは **`1.20.4/main.mcb`（純正テンプレート）にも同一に存在する**。
  `1.20.4-tsb/main.mcb` は `1.20.4/` からの複製であり引き継いだだけで、
  **TSB Phase B-1 の変更が原因ではない**。
- Minecraft 1.21.5 未満を対象とする全 export に影響する upstream 共通バグ。

## 修正案

- **案 a**: `TELLRAW.*` が `TextComponent` インスタンスではなく
  `.toString(true, <targetVersion>)` 済みの JSON 文字列を返すよう変更する。
  `mc-build` の文字列化機構に依存しなくなる。
- **案 b**: `mc-build` 側の `<%...%>` 結果文字列化がターゲットバージョンを
  使うよう修正する。
- いずれも upstream コード（`tellraw.ts` / `mc-build` 連携）への変更で、
  全バージョンの export に影響するため regression 確認が必要。

## 要決定事項

upstream バグとして別途対応するか、TSB の 1.20.4 対応の一環として案 a を
先行適用するか。TSB Phase B-1 のスコープ外のため、本検証では保留とする。
