# TSB Known Issue: TRS 分解（10 floats）がせん断を静かに欠落させる

- **ステータス**: 対応方針決定済み（せん断検出 sanity check を追加。実装は別タスク）
- **発見日**: 2026-05-21（Phase B-1 生成検証 / コードレビュー）
- **重大度**: 中〜高（該当リグでは描画リグレッション。ただし非一様スケール未使用なら無害）
- **発生箇所**: `src/systems/datapackCompiler/createAnimationStorageTsb.ts`
  （`buildBoneFramesObj` が `transform.decomposed` を使用）

## 背景: AJ 本体は何を出力しているか

AJ の datapack export は、bone の display entity `transformation` に
**フル 4×4 行列をそのまま**書き込んでいる。

- `src/systems/util.ts:24` `matrixToNbtFloatArray()` — 行列を transpose して
  **16 floats** 配列化する。
- 全 `main.mcb`（1.20.4 / 1.20.4-tsb / 1.21.x）の
  `transformation: ${matrixToNbtFloatArray(transform.matrix)...}`。
- `src/systems/datapackCompiler/index.ts:275` — 既存の `use_storage_for_animation`
  ストレージモードも `matrixToNbtFloatArray(transform.matrix)` を使用。

`INodeTransform` には `decomposed`（translation + left_rotation + scale）という
TRS 形も存在するが、それを NBT 化する `transformationToNbt` は **datapack export
では呼ばれていない**（import と mcb 変数渡しのみで未使用）。

つまり **「translation + left_rotation + scale だけ出力」しているのは AJ 本体ではなく、
`createAnimationStorageTsb`（TSB 変換）が新規に導入した 10 floats 縮約**である。
AJ 本体・既存ストレージモードはフル行列 = せん断を完全に保持している。

## せん断は発生しうる

`transform.matrix` は `getNodeMatrix()`（`src/systems/animationRenderer.ts:26`）が
返す `node.mesh.matrixWorld` — 階層を畳み込んだ**ワールド行列**である。

せん断は **非一様スケールと回転が階層の異なるレベルで合成されたとき**に発生する:

- 親グループに非一様スケール（例 x2 / y1 / z1）→ 子ボーンが回転 →
  子のワールド行列 `S_parent · R_child` の基底ベクトルが直交しなくなる = せん断。

Blockbench は bone ごとに per-axis スケールキーフレームを設定できるため、
これは構造的に起こりうる（親をスカッシュ&ストレッチさせて子を回す等）。

## なぜ 10 floats で壊れるか

`getDecomposedTransformation()`（`src/systems/animationRenderer.ts:43-48`）は
`matrix.decompose(translation, leftRotation, scale)` を呼ぶだけ。これは
**単純 TRS 分解**（回転 1 個）であり、せん断を表現できない。せん断のある行列を
分解 → 再合成しても元に戻らず、**警告なしに誤った変換になる**。

## 資料 A-6 の論理の誤り

`tsb-output-sample.md` の A-6「AJ 自体が `THREE.Matrix4.decompose` で shear 情報を
捨てる仕様のため shear cell は発生しえず、14 floats 拡張は廃止」は誤り:

- AJ 本体は `decompose` で export していない（フル行列を使用）。`decompose` を
  使うのは TSB 変換のみ。
- `decompose` がせん断を捨てるのは事実だが、それは「せん断が起きない」ではなく
  「起きたら失われる」を意味する。論理が逆。
- Minecraft の display `transformation` 分解形は
  `translation + left_rotation + scale + right_rotation`。
  `T · R_left · S · R_right` は SVD（任意行列 = U Σ Vᵀ）に対応するため、
  **right_rotation 込みの 14 floats ならせん断を完全表現できる**。
  A-6 はこの 14 floats 案を誤った前提で廃止している。

## 影響

| 出力経路 | せん断 |
|---|---|
| AJ 本体（フル行列 16 floats） | 保持 |
| 既存ストレージモード（同上） | 保持 |
| TSB 10 floats（decomposed） | **静かに欠落** |

非一様スケール + 回転を使うリグでは、TSB export は既存モードに対する
描画リグレッションになる。非一様スケールを使わないリグでは無害。

## 対応方針

10 floats フォーマットは維持しつつ、**せん断検出 sanity check を追加する**。

- `createAnimationStorageTsb` の各 bone セル生成時、`transform.decomposed` を
  再合成した行列（`THREE.Matrix4.compose(t, r, s)`）と元の `transform.matrix` を
  比較する。`INodeTransform` は `.matrix`（フル）と `.decomposed`（TRS）の両方を
  保持しているため、追加データ取得は不要。
- 誤差が閾値を超えたセルが見つかったら、`ensureLineWithinLimit`
  （`MAX_LINE_BYTES` チェック）と同様にエラー / 警告を出力する。
  これにより「静かに壊れる」状態を防ぐ。
- 実装位置の目安: `buildBoneFramesObj`（`createAnimationStorageTsb.ts:228`）周辺、
  `ensureLineWithinLimit` の隣。

実装はせん断発生を計算で判定して出力するだけで、フォーマット自体の再設計は
伴わないため、作業量は限定的。実装は本検証とは別タスクとする。
