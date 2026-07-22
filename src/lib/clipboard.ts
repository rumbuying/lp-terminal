/**
 * Copy text, reporting whether it actually landed.
 *
 * `navigator.clipboard` needs a secure context — https or localhost. That
 * covers the deployed site and `npm run dev`, but NOT a phone pointed at the
 * dev server over the LAN (http://192.168.x.x), where the API is simply
 * undefined. The textarea path is the fallback for exactly that case, and the
 * boolean matters: a copy button that flashes "COPIED" without copying is worse
 * than one that admits it failed, because the address the user then pastes is
 * whatever happened to be in the clipboard already.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* permission denied or no clipboard — fall through to the legacy path */
  }
  // `finally`, not a trailing remove(): execCommand THROWS rather than
  // returning false in some browsers (sandboxed frames, denied permission),
  // and every throw used to strand its textarea in the document forever
  let ta: HTMLTextAreaElement | null = null
  try {
    ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // off-screen but still selectable; `display:none` would not be
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length) // iOS ignores select() on readonly
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta?.remove()
  }
}
