/**
 * `.mcb` テンプレートの生成物を headless で検査する。
 *
 * Blockbench も Minecraft サーバも起動せずに datapack の生成結果を確認するための土台。
 * `compileDataPack` (index.ts) 全体は `Project!` global / `getFsModule()` / svelte store に
 * 依存して Node 上では動かないが、`compileMcbProject` は sourceFiles / variables /
 * exportedFiles を受け取るだけなので、その手前を自前で組めば回せる。
 */
import { describe, expect, it } from 'vitest'
import { compileMcbProject } from '../systems/datapackCompiler/mcbCompiler'
import type { ExportedFile } from '../systems/util'

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
