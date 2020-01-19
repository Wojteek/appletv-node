import { EventEmitter } from 'events'

export default class TypedEventEmitter<T> extends EventEmitter {
  constructor(...args) {
    super()
  }

  _on(event: string, callback: (...args) => void): this {
    return super.on(event, callback)
  }

  on(event: string, callback: (arg: any) => void): this {
    return super.on(event, callback)
  }

  emit(event: string, payload?: any): boolean {
    return super.emit(event, payload)
  }
}