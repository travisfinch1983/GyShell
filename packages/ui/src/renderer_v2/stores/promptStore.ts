import { makeAutoObservable } from 'mobx'

/** Promise-based in-UI text prompt (replaces window.prompt). One <PromptHost/> is mounted globally;
 *  call promptStore.prompt({...}) anywhere and await the string (or null if cancelled). */
class PromptStore {
  open = false
  title = ''
  label = ''
  placeholder = ''
  value = ''
  confirmText = 'Save'
  private resolver: ((v: string | null) => void) | null = null

  constructor() { makeAutoObservable(this) }

  prompt(o: { title: string; label?: string; placeholder?: string; defaultValue?: string; confirmText?: string }): Promise<string | null> {
    this.title = o.title
    this.label = o.label || ''
    this.placeholder = o.placeholder || ''
    this.value = o.defaultValue || ''
    this.confirmText = o.confirmText || 'Save'
    this.open = true
    return new Promise((res) => { this.resolver = res })
  }
  setValue(v: string): void { this.value = v }
  submit(): void { this.finish(this.value.trim() || null) }
  cancel(): void { this.finish(null) }
  private finish(v: string | null): void {
    this.open = false
    const r = this.resolver
    this.resolver = null
    r?.(v)
  }
}

export const promptStore = new PromptStore()
