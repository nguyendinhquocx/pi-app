/**
 * Language for a fresh install. This fork ships a built-in Vietnamese UI, so a fresh install
 * (no saved preference) starts Vietnamese regardless of the system locale; zh/en only apply
 * after the user explicitly saves that choice.
 */
export function defaultAppLanguage(
  _env: NodeJS.ProcessEnv = process.env,
  _systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): 'zh' | 'en' | 'vi' {
  return 'vi'
}
