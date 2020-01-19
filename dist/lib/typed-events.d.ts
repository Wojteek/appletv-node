/// <reference types="node" />
import { EventEmitter } from 'events';
export default class TypedEventEmitter<T> extends EventEmitter {
    constructor(...args: any[]);
    _on(event: string, callback: (...args: any[]) => void): this;
    on(event: string, callback: (arg: any) => void): this;
    emit(event: string, payload?: any): boolean;
}
