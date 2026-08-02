/**
 * `.mcb` テンプレートの生成物を headless で検査する。
 *
 * Blockbench も Minecraft サーバも起動せずに datapack の生成結果を確認するための土台。
 * `compileDataPack` (index.ts) 全体は `Project!` global / `getFsModule()` / svelte store に
 * 依存して Node 上では動かないが、`compileMcbProject` は sourceFiles / variables /
 * exportedFiles を受け取るだけなので、その手前を自前で組めば回せる。
 */
import { describe, expect, it, vi } from 'vitest'

// formats/blueprint は svelte component / svg asset / Blockbench API を芋づるで引くため
// vitest では解決できない。 tellraw.ts と systems/util.ts が使うのは
// projectTargetVersionIsAtLeast だけなので、 忠実な最小コピーで差し替える。
vi.mock('../formats/blueprint', () => ({
	projectTargetVersionIsAtLeast(version: string): boolean {
		if (!Project?.animated_java) return false
		return !compareVersions(version, Project.animated_java.target_minecraft_version)
	},
}))

// minecraftUtil は constants.getFsModule / systems/minecraft/* を芋づるで引く。
// tellraw.ts が使うのは toSmallCaps だけで、 生成物の assert 対象は小文字装飾の
// 有無ではないため identity で差し替える。
vi.mock('../util/minecraftUtil', () => ({
	toSmallCaps: (str: string) => str,
}))

// tellraw.ts の `import { type IRenderedAnimation } from '../animationRenderer'` は
// verbatimModuleSyntax の下で side-effect import として残るため、 型しか使っていないのに
// Blockbench 結合の実体 (= 最終的に svelte-patching-tools/blockbench → Dialog global) が
// ロードされてしまう。 実行時に参照される値は無いので空モジュールで差し替える。
vi.mock('../systems/animationRenderer', () => ({}))
vi.mock('../systems/rigRenderer', () => ({}))

import { compileMcbProject } from '../systems/datapackCompiler/mcbCompiler'
import type { ExportedFile } from '../systems/util'
import { compileFixture } from './fixtures/minimalRig'

/** Map から `suffix` で終わるキーのファイル内容を 1 つだけ取り出す。 */
function getFileBySuffix(files: Map<string, string>, suffix: string): string {
	const matches = [...files.keys()].filter(path => path.endsWith(suffix))
	expect(matches, `no file matching '${suffix}'`).toHaveLength(1)
	return files.get(matches[0])!
}

/** Map に `suffix` で終わるキーが存在するか。 */
function hasFileBySuffix(files: Map<string, string>, suffix: string): boolean {
	return [...files.keys()].some(path => path.endsWith(suffix))
}

describe('compileMcbProject smoke', () => {
	it('最小の .mcb から関数ファイルを生成できる', async () => {
		const exportedFiles = new Map<string, ExportedFile>()

		await compileMcbProject({
			sourceFiles: {
				'src/smoke.mcb': 'function hello {\n\tsay hi\n}\n',
			},
			destPath: '.',
			variables: {},
			version: '1.20.4',
			exportedFiles,
			// misode の版数取得 (外部 fetch) を迂回する。 値は 1.20.4 の data pack format。
			formatVersion: 26,
			quiet: true,
		})

		expect(exportedFiles.size).toBeGreaterThan(0)
	})
})

describe('1.20.4-tsb fixture compile', () => {
	it('bone / locator / camera を含む rig から datapack を生成できる', async () => {
		const files = await compileFixture()

		expect(files.size).toBeGreaterThan(0)
		// global (animated_java namespace) と project (blueprint namespace) の両方が出ること。
		expect(
			[...files.keys()].some(path => path.includes('/animated_java/')),
			'animated_java namespace の関数が無い'
		).toBe(true)
		expect(
			[...files.keys()].some(path => path.includes('/aj/')),
			'blueprint namespace の関数が無い'
		).toBe(true)
	})
})

/**
 * `1.20.4-tsb/global.mcb` の `dir remove` / `outdated_rig` 回帰テスト。
 *
 * 旧実装は 3 つのバグが重なって「古い locator / camera が削除されず残る」状態だった :
 * 1. UUID 一覧を entity NBT (`from entity @s data.uuids`) から読もうとしていた
 *    (= entity の保存 NBT に `data` compound は存在せず、 NbtPath が not-found で落ちる)
 * 2. list の要素を compound 扱いして `uuids[-1].uuid` を読んでいた
 *    (= 実際の要素は gu の out をそのまま append した UUID 文字列)
 * 3. 引数 key が呼び先 `entity_stack_by_uuid` の `#ARGS: {uuid: string}` と食い違っていた
 *    (`args.current_uuid`)
 *
 * ループ本体は `block loop_over_uuids { ... }` として書かれているため、 mc-build が
 * 兄弟ファイル `remove/loop_over_uuids.mcfunction` に切り出す。 2 つ目のバグの検査対象は
 * そちら側になる (= 名前付き block なので `zzz/<数字>` と違って番号が動かない)。
 *
 * 生成物の `zzz/<数字>` 匿名関数の番号は分岐数に依存して変わるため、 Map 全体の snapshot は
 * 取らず、 名前の付いたファイルに対する意味的な assert のみを書く。
 */
describe('1.20.4-tsb global/remove/outdated_rig', () => {
	it('UUID 一覧を storage 側から読み、文字列要素をそのまま args.uuid に渡す', async () => {
		const files = await compileFixture()
		const outdatedRig = getFileBySuffix(files, '/remove/outdated_rig.mcfunction')
		const loopOverUuids = getFileBySuffix(files, '/remove/loop_over_uuids.mcfunction')

		// 1. UUID 一覧は data_manager が読み込んだ storage 側から取る。
		expect(outdatedRig).toContain('set from storage animated_java:temp entry.data.uuids')
		// 2 + 3. 要素は UUID 文字列そのもの、 key は呼び先の #ARGS に合わせて `uuid`。
		expect(loopOverUuids).toContain('args.uuid set from storage animated_java:temp uuids[-1]')

		// 旧バグの痕跡が残っていないこと。
		for (const content of [outdatedRig, loopOverUuids]) {
			expect(content).not.toContain('from entity @s data.uuids')
			expect(content).not.toContain('uuids[-1].uuid')
			expect(content).not.toContain('args.current_uuid')
		}
	})
})

/**
 * blueprint 側 (= `aj:test_rig`) の on_load。 `animated_java` 側の
 * `global/on_load.mcfunction` と区別するため namespace 込みの path で絞る。
 */
const PROJECT_ON_LOAD = '/aj/functions/test_rig/on_load.mcfunction'

/** 生成物のうち `variants/` 配下のパスだけを列挙する (= gate が開いたかの判定に使う)。 */
function variantFilePaths(files: Map<string, string>): string[] {
	return [...files.keys()].filter(path => path.includes('/variants/')).sort()
}

/** on_load から variant metadata (`<bp>:meta d.variants`) を触る行だけを抜き出す。 */
function variantMetaLines(onLoad: string): string[] {
	return onLoad.split('\n').filter(line => line.includes(':meta d.variants'))
}

/**
 * `needs_variant_functions` gate の回帰テスト。
 *
 * 旧実装の gate は `Object.keys(rig.variants).length > 1` だったが、 `rig.variants` には
 * default が常に 1 個含まれるため、 実質「カスタム variant あり」の意味になっていた。
 * 結果、 default variant しか無い blueprint では `dir variants` が丸ごと生成されず、
 * UI で root On-Apply Function を設定しても datapack に出力されなかった。
 *
 * 現行 gate は `hasCustomVariants || hasVariantOnApply || hasVariantKeyframes` の OR で、
 * animation の有無からも独立している。
 */
describe('1.20.4-tsb variants gate (needs_variant_functions)', () => {
	it('default variant のみ + On-Apply あり + animation なしでも variants/ が出る', async () => {
		const files = await compileFixture({
			variants: [{ name: 'default', isDefault: true, onApplyFunction: 'say applied' }],
		})

		expect(hasFileBySuffix(files, '/variants/default/apply.mcfunction')).toBe(true)
		expect(hasFileBySuffix(files, '/variants/_apply.mcfunction')).toBe(true)
		// root On-Apply Function 本体も variant 単位で切り出される。
		expect(hasFileBySuffix(files, '/variants/default/_on_apply.mcfunction')).toBe(true)

		// metadata は animation 用の block ではなく needs_variant_functions 側の block から出る。
		const onLoad = getFileBySuffix(files, PROJECT_ON_LOAD)
		const metaLines = variantMetaLines(onLoad)
		expect(metaLines).toHaveLength(1)
		expect(metaLines[0]).toContain('d.variants set value')
		// `_apply` の dispatch ガードになるフラグ。
		expect(metaLines[0]).toContain('on_apply:1b')
	})

	it('animation を足しても On-Apply の出力結果は変わらない', async () => {
		const withoutAnimations = await compileFixture({
			variants: [{ name: 'default', isDefault: true, onApplyFunction: 'say applied' }],
		})
		const withAnimations = await compileFixture({
			variants: [{ name: 'default', isDefault: true, onApplyFunction: 'say applied' }],
			animations: [{ name: 'idle' }],
		})

		// variants/ の生成物と d.variants の中身がどちらも一致すること。
		expect(variantFilePaths(withAnimations)).toEqual(variantFilePaths(withoutAnimations))
		expect(variantMetaLines(getFileBySuffix(withAnimations, PROJECT_ON_LOAD))).toEqual(
			variantMetaLines(getFileBySuffix(withoutAnimations, PROJECT_ON_LOAD))
		)

		expect(hasFileBySuffix(withAnimations, '/variants/default/_on_apply.mcfunction')).toBe(true)
	})

	it('On-Apply が無くても variant keyframe があれば variants/ が出る', async () => {
		const files = await compileFixture({
			animations: [{ name: 'idle', frameVariants: [['default'], undefined] }],
		})

		expect(hasFileBySuffix(files, '/variants/_apply.mcfunction')).toBe(true)
		expect(hasFileBySuffix(files, '/variants/_apply_at_frame.mcfunction')).toBe(true)
		// On-Apply Function は無いので _on_apply は出ない。
		expect(hasFileBySuffix(files, '/variants/default/_on_apply.mcfunction')).toBe(false)

		expect(variantMetaLines(getFileBySuffix(files, PROJECT_ON_LOAD))[0]).toContain(
			'd.variants set value'
		)
	})

	it('On-Apply も variant keyframe も無ければ variants/ は出ず d.variants を remove する', async () => {
		const files = await compileFixture()

		expect(variantFilePaths(files)).toEqual([])

		// TSB 経路は on_load で cleanup を呼ばないため、 gate が閉じた経路では
		// 旧 export が残した d.variants を明示的に消す必要がある。
		const metaLines = variantMetaLines(getFileBySuffix(files, PROJECT_ON_LOAD))
		expect(metaLines).toHaveLength(1)
		expect(metaLines[0]).toContain('data remove storage aj.test_rig:meta d.variants')
		expect(metaLines[0]).not.toContain('set value')
	})

	it('custom variant があれば従来どおり全 variant の apply が出る', async () => {
		const files = await compileFixture({
			variants: [{ name: 'default', isDefault: true }, { name: 'damaged' }],
		})

		expect(hasFileBySuffix(files, '/variants/default/apply.mcfunction')).toBe(true)
		expect(hasFileBySuffix(files, '/variants/damaged/apply.mcfunction')).toBe(true)

		const metaLines = variantMetaLines(getFileBySuffix(files, PROJECT_ON_LOAD))
		expect(metaLines).toHaveLength(1)
		expect(metaLines[0]).toContain('d.variants set value')
		expect(metaLines[0]).toContain('damaged:')
	})
})
