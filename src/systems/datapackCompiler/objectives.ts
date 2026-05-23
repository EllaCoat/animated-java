namespace OBJECTIVES {
	export const I = () => 'aj.i'
	export const ID = () => 'aj.id'
	export const FRAME = (animationName: string) => `aj.${animationName}.frame`
	export const IS_RIG_LOADED = () => 'aj.is_rig_loaded'
	export const TWEEN_DURATION = () => 'aj.tween_duration'
	// blueprintId は `namespace:path` 形式 (例: `aj:axia`)。 objective 名に `:` は使えないため
	// `.` に置換する (既存 `project_storage.replace(':', '.')` パターンと整合)。
	// 結果 : `aj:axia` → `aj.axia.dur` (頭 aj は blueprintId 由来、 二重付与しない)。
	export const DUR = (blueprintId: string) =>
		`${blueprintId.replace(':', '.')}.dur`
	export const TP_DUR = (blueprintId: string) =>
		`${blueprintId.replace(':', '.')}.tp_dur`
	export const CURRENT_ANIM = (blueprintId: string) =>
		`${blueprintId.replace(':', '.')}.current_anim`
	export const BONE_ID = (blueprintId: string) =>
		`${blueprintId.replace(':', '.')}.bone_id`
	export const LOCATOR_ID = (blueprintId: string) =>
		`${blueprintId.replace(':', '.')}.locator_id`
	// Phase C : frame counter は bp 単位 1 個に共通化 (純正の anim 別 FRAME は anim_id macro で
	// アクセスできないため統一)。 同時再生は 1 anim まで = pause/resume は同 anim_id を前提とし、
	// 別 anim を play で切り替えるなら frame=0 で start する仕様。
	export const FRAME_BP = (blueprintId: string) =>
		`${blueprintId.replace(':', '.')}.frame`
}

export default OBJECTIVES
