import { defineConfig } from 'vitest/config'

export default defineConfig({
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
