import { makeAutoObservable } from 'mobx'

/** Promise-based in-UI confirm (replaces window.confirm). One <ConfirmHost/> is mounted globally;
 *  call confirmStore.confirm({...}) anywhere and await the boolean. */
class ConfirmStore {
  open = false
  title = ''
  message = ''
  confirmText = 'Confirm'
  cancelText = 'Cancel'
  danger = true
  private resolver: ((v: boolean) => void) | null = null

  constructor() { makeAutoObservable(this) }

  confirm(o: { title: string; message: string; confirmText?: string; cancelText?: string; danger?: boolean }): Promise<boolean> {
    this.title = o.title
    this.message = o.message
    this.confirmText = o.confirmText || 'Confirm'
    this.cancelText = o.cancelText || 'Cancel'
    this.danger = o.danger ?? true
    this.open = true
    return new Promise((res) => { this.resolver = res })
  }
  resolve(v: boolean): void {
    this.open = false
    const r = this.resolver
    this.resolver = null
    r?.(v)
  }
}

export const confirmStore = new ConfirmStore()
