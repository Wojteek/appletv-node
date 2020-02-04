import { Service } from 'mdns';
import * as path from 'path';
import { load } from 'protobufjs'
import { v4 as uuid } from 'uuid';
import { promisify } from 'util';
import { Connection } from './connection';

import { Pairing } from './pairing';
import { Verifier } from './verifier';
import { Credentials } from './credentials';
import { NowPlayingInfo } from './now-playing-info';
import { SupportedCommand } from './supported-command';
import TypedEventEmitter from './typed-events';
import { Message } from './message';
import number from './util/number';

const { name } = require('../../package.json');

export interface Size {
  width: number;
  height: number;
}

export interface PlaybackQueueRequestOptions {
  location: number;
  length: number;
  includeMetadata?: boolean;
  includeLanguageOptions?: boolean;
  includeLyrics?: boolean;
  artworkSize?: Size;
}

export interface ClientUpdatesConfig {
  artworkUpdates: boolean;
  nowPlayingUpdates: boolean;
  volumeUpdates: boolean;
  keyboardUpdates: boolean;
}

const delay = promisify(setTimeout);

export class AppleTV extends TypedEventEmitter<AppleTV.Events> {
  public name: string;
  public address: string;
  public port: number;
  public uid: string;
  public pairingId: string = uuid();
  public credentials: Credentials;

  private connection: Connection;

  constructor(private service: Service) {
    super();

    this.service = service;
    this.name = service.txtRecord.Name;
    if (service.addresses.length > 1) {
      this.address = service.addresses[1];
    } else {
      this.address = service.addresses[0];
    }
    this.port = service.port;
    this.uid = service.txtRecord.UniqueIdentifier;
    this.connection = new Connection(this);

    let that = this;
    this.connection.on('message', (message: Message) => {
      that.emit('message', message);
      if (message.type == Message.Type.SetStateMessage) {
        if (message.payload == null) {
          that.emit('nowPlaying', null);
          return;
        }
        if (message.payload.nowPlayingInfo) {
          let info = new NowPlayingInfo(message.payload);
          that.emit('nowPlaying', info);
        }
        if (message.payload.supportedCommands) {
          let commands = (message.payload.supportedCommands.supportedCommands || [])
            .map(sc => {
              return new SupportedCommand(sc.command, sc.enabled || false, sc.canScrub || false);
            });
          that.emit('supportedCommands', commands);
        }
        if (message.payload.playbackQueue) {
          that.emit('playbackQueue', message.payload.playbackQueue);
        }
      }
    })
    .on('connect', () => {
      that.emit('connect');
    })
    .on('close', () => {
      that.emit('close');
    })
    .on('error', (error) => {
      that.emit('error', error);
    })
    .on('debug', (message) => {
      that.emit('debug', message);
    });

    let queuePollTimer = null;
    this._on('newListener', (event, listener) => {
      if (queuePollTimer == null && (event == 'nowPlaying' || event == 'supportedCommands')) {
        queuePollTimer = setInterval(() => {
          if (that.connection.isOpen) {
            that.requestPlaybackQueueWithWait({
              length: 100,
              location: 0,
              artworkSize: {
                width: -1,
                height: 368
              }
            }, false).then(() => {}).catch(error => {});
          }
        }, 5000);
      }
    });
    this._on('removeListener', (event, listener) => {
      if (queuePollTimer != null && (event == 'nowPlaying' || event == 'supportedCommands')) {
        let listenerCount = that.listenerCount('nowPlaying') + that.listenerCount('supportedCommands');
        if (listenerCount == 0) {
          clearInterval(queuePollTimer);
          queuePollTimer = null;
        }
      }
    });
  }

  /**
  * Pair with an already discovered AppleTV.
  * @returns A promise that resolves to the AppleTV object.
  */
  pair(): Promise<(pin: string) => Promise<AppleTV>> {
    let pairing = new Pairing(this);
    return pairing.initiatePair();
  }

  /**
  * Opens a connection to the AppleTV over the MRP protocol.
  * @param credentials  The credentials object for this AppleTV
  * @returns A promise that resolves to the AppleTV object.
  */
  openConnection(credentials?: Credentials): Promise<AppleTV> {
    let that = this;

    if (credentials) {
      this.pairingId = credentials.pairingId;      
    }
    
    return this.connection
      .open()
      .then(() => {
        return that.sendIntroduction();
      })
      .then(() => {
        that.credentials = credentials;
        if (credentials) {
          let verifier = new Verifier(that);
          return verifier.verify()
            .then(keys => {
              that.credentials.readKey = keys['readKey'];
              that.credentials.writeKey = keys['writeKey'];
              that.emit('debug', 'DEBUG: Keys Read=' + that.credentials.readKey.toString('hex') + ', Write=' + that.credentials.writeKey.toString('hex'));
              return that.sendConnectionState();
            });
        } else {
          return null;
        }
      })
      .then(() => {
        if (credentials) {
          return that.sendClientUpdatesConfig({
            nowPlayingUpdates: true,
            artworkUpdates: true,
            keyboardUpdates: false,
            volumeUpdates: false
          });
        } else {
          return null;
        }
      })
      .then(() => {
        return Promise.resolve(that);
      });
  }

  /**
  * Closes the connection to the Apple TV.
  */
  closeConnection() {
    this.connection.close();
  }

  /**
  * Send a Protobuf message to the AppleTV. This is for advanced usage only.
  * @param definitionFilename  The Protobuf filename of the message type.
  * @param messageType  The name of the message.
  * @param body  The message body
  * @param waitForResponse  Whether or not to wait for a response before resolving the Promise.
  * @returns A promise that resolves to the response from the AppleTV.
  */
  sendMessage(definitionFilename: string, messageType: string, body: {}, waitForResponse: boolean, priority: number = 0): Promise<Message> {
    return load(path.resolve(__dirname + '/protos/' + definitionFilename + '.proto'))
      .then(root => {
        let type = root.lookupType(messageType);
        return type.create(body);
      })
      .then(message => {
        return this.connection
          .send(message, waitForResponse, priority, this.credentials);
      });
  }

  /**
  * Wait for a single message of a specified type.
  * @param type  The type of the message to wait for.
  * @param timeout  The timeout (in seconds).
  * @returns A promise that resolves to the Message.
  */
  messageOfType(type: Message.Type, timeout: number = 5): Promise<Message> {
    let that = this;
    return new Promise<Message>((resolve, reject) => {
      let listener: (message: Message) => void;
      let timer = setTimeout(() => {
        reject(new Error('Timed out waiting for message type ' + type));
        that.removeListener('message', listener);
      }, timeout * 1000);
      listener = (message: Message) => {
        if (message.type == type) {
          resolve(message);
          that.removeListener('message', listener);
        }
      };
      that.on('message', listener);
    });
  }

  /**
  * Requests the current playback queue from the Apple TV.
  * @param options Options to send
  * @returns A Promise that resolves to a NewPlayingInfo object.
  */
  requestPlaybackQueue(options: PlaybackQueueRequestOptions): Promise<NowPlayingInfo> {
    return this.requestPlaybackQueueWithWait(options, true);
  }

  /**
  * Send a key command to the AppleTV.
  * @param key The key to press.
  * @returns A promise that resolves to the AppleTV object after the message has been sent.
  */
  sendKeyCommand(key: AppleTV.Key): Promise<AppleTV> {
    switch (key) {
      case AppleTV.Key.Up:
        return this.sendKeyPressAndRelease(1, 0x8C);
      case AppleTV.Key.Down:
        return this.sendKeyPressAndRelease(1, 0x8D);
      case AppleTV.Key.Left:
        return this.sendKeyPressAndRelease(1, 0x8B);
      case AppleTV.Key.Right:
        return this.sendKeyPressAndRelease(1, 0x8A);
      case AppleTV.Key.Menu:
        return this.sendKeyPressAndRelease(1, 0x86);
      case AppleTV.Key.Play:
        return this.sendKeyPressAndRelease(12, 0xB0);
      case AppleTV.Key.Pause:
        return this.sendKeyPressAndRelease(12, 0xB1);
      case AppleTV.Key.Next:
        return this.sendKeyPressAndRelease(12, 0xB5);
      case AppleTV.Key.Previous:
        return this.sendKeyPressAndRelease(12, 0xB6);
      case AppleTV.Key.Suspend:
        return this.sendKeyPressAndRelease(1, 0x82);
      case AppleTV.Key.Select:
        return this.sendKeyPressAndRelease(1, 0x89);
      case AppleTV.Key.Topmenu:
        return this.sendKeyPressAndRelease(12, 0x60);
      case AppleTV.Key.WakeUp:
        return this.sendKeyPressAndRelease(1, 0x83);
      case AppleTV.Key.VolumeUp:
        return this.sendKeyPressAndRelease(12, 0xE9);
      case AppleTV.Key.VolumeDown:
        return this.sendKeyPressAndRelease(12, 0xEA);
      case AppleTV.Key.Home:
        return this.sendKeyPressAndRelease(12, 0x40);
      case AppleTV.Key.HomeHold:
        return this.sendKeyPressAndRelease(12, 0x40, true);
    }
  }

  private async sendKeyPressAndRelease(usePage: number, usage: number, hold = false): Promise<AppleTV> {
    await this.sendKeyPress(usePage, usage, true);

    if (hold) {
      await delay(1000);
    }

    return this.sendKeyPress(usePage, usage, false);
  }

  private sendKeyPress(usePage: number, usage: number, down: boolean): Promise<AppleTV> {
    let time = Buffer.from('438922cf08020000', 'hex');
    let data = Buffer.concat([
      number.UInt16toBufferBE(usePage),
      number.UInt16toBufferBE(usage),
      down ? number.UInt16toBufferBE(1) : number.UInt16toBufferBE(0)
    ]);

    let body = {
      hidEventData: Buffer.concat([
        time,
        Buffer.from('00000000000000000100000000000000020' + '00000200000000300000001000000000000', 'hex'),
        data,
        Buffer.from('0000000000000001000000', 'hex')
      ])
    };
    let that = this;
    return this.sendMessage('SendHIDEventMessage', 'SendHIDEventMessage', body, false)
      .then(() => {
        return that;
      });
  }

  private requestPlaybackQueueWithWait(options: PlaybackQueueRequestOptions, waitForResponse: boolean): Promise<any> {
    const params: any = options;

    params.requestID = uuid();
    if (options.artworkSize) {
      params.artworkWidth = options.artworkSize.width;
      params.artworkHeight = options.artworkSize.height;
      delete params.artworkSize;
    }
    return this.sendMessage('PlaybackQueueRequestMessage', 'PlaybackQueueRequestMessage', params, waitForResponse);
  }

  sendIntroduction(): Promise<Message> {
    const body = {
      uniqueIdentifier: this.pairingId,
      name: 'appletv-node',
      localizedModelName: 'iPhone',
      systemBuildVersion: '17B111',
      applicationBundleIdentifier: 'com.apple.TVRemote',
      applicationBundleVersion: '344.28',
      protocolVersion: 1,
      allowsPairing: true,
      lastSupportedMessageType: 77,
      supportsSystemPairing: true,
      supportsSharedQueue: true,
      supportsACL: true,
      supportsExtendedMotion: true,
      sharedQueueVersion: 2,
      deviceClass: 1,
      logicalDeviceCount: 1,
    };

    return this.sendMessage('DeviceInfoMessage', 'DeviceInfoMessage', body, true);
  }

  private sendConnectionState(): Promise<Message> {
    let that = this;
    return load(path.resolve(__dirname + '/protos/SetConnectionStateMessage.proto'))
      .then(root => {
        let type = root.lookupType('SetConnectionStateMessage');
        let stateEnum = type.lookupEnum('ConnectionState');
        let message = type.create({
          state: stateEnum.values['Connected']
        });

        return that
          .connection
          .send(message, false, 0, that.credentials);
      });
  }

  private sendClientUpdatesConfig(config: ClientUpdatesConfig): Promise<Message> {
    return this.sendMessage('ClientUpdatesConfigMessage', 'ClientUpdatesConfigMessage', config, false);
  }
}

export module AppleTV {
  export interface Events {
    connect: void;
    nowPlaying: NowPlayingInfo;
    supportedCommands: SupportedCommand[];
    playbackQueue: any;
    message: Message
    close: void;
    error: Error;
    debug: string;
  }
}

export module AppleTV {
  export enum Key {
    Up,
    Down,
    Left,
    Right,
    Menu,
    Play,
    Pause,
    Next,
    Previous,
    Suspend,
    Select,
    Topmenu,
    WakeUp,
    VolumeUp,
    VolumeDown,
    Home,
    HomeHold,
  }

  export function key(key: string): AppleTV.Key {
    switch (key) {
      case 'up':
        return AppleTV.Key.Up;
      case 'down':
        return AppleTV.Key.Down;
      case 'left':
        return AppleTV.Key.Left;
      case 'right':
        return AppleTV.Key.Right;
      case 'menu':
        return AppleTV.Key.Menu;
      case 'play':
        return AppleTV.Key.Play;
      case 'pause':
        return AppleTV.Key.Pause;
      case 'previous':
        return AppleTV.Key.Previous;
      case 'suspend':
        return AppleTV.Key.Suspend;
      case 'select':
        return AppleTV.Key.Select;
      case 'topmenu':
        return AppleTV.Key.Topmenu;
      case 'wakeup':
        return AppleTV.Key.WakeUp;
      case 'volumeup':
        return AppleTV.Key.VolumeUp;
      case 'volumedown':
        return AppleTV.Key.VolumeDown;
      case 'home':
        return AppleTV.Key.Home;
      case 'homehold':
        return AppleTV.Key.HomeHold;
    }
  }
}
