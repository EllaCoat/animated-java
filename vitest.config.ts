import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			// src 側は `deepslate/lib/nbt` で import しているが、 deepslate の package.json
			// "exports" が公開しているのは `./nbt` (= `lib/nbt/main.js`) だけ。 production build では
			// `.scripts/esbuild.ts` の DEPENDENCY_QUARKS plugin が手動解決しているため通るが、
			// vitest には同 plugin が無く import-analysis で落ちる。 `lib/nbt/main.js` は
			// `lib/nbt/index.js` の re-export なので、 alias で公開 subpath に寄せて吸収する。
			'deepslate/lib/nbt': 'deepslate/nbt',
		},
	},
	test: {
		dir: 'src/tests',
		server: {
			deps: {
				// `generic-stream` の dist/index.js は拡張子無しで subpath を re-export
				// しており Node ESM の strict resolver では解決できない (`./genericStream` を
				// `./genericStream.js` に直さない)。 inline transform 経由なら esbuild が
				// 拡張子補完で解決するため、 これで book-and-quill 連鎖を救う。
				inline: ['generic-stream', 'book-and-quill'],
			},
		},
	},
})
