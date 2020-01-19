import { AppleTV } from './appletv';
export declare class Verifier {
    device: AppleTV;
    static ED25519: string;
    constructor(device: AppleTV);
    verify(): Promise<{}>;
    private waitForSequence;
}
