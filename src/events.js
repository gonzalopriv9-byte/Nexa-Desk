import { EventEmitter } from 'node:events';

export class AppEvents extends EventEmitter {
  publish(type, payload = {}) {
    this.emit('event', {
      type,
      payload,
      createdAt: new Date().toISOString()
    });
  }
}
