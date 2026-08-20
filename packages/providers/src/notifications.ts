import type { JsonValue } from "@intelligence/core";
import type { NotificationProvider, NotificationType } from "./interfaces.js";

export class ConsoleNotificationProvider implements NotificationProvider {
  async notify(type: NotificationType, payload: JsonValue): Promise<void> {
    console.info(JSON.stringify({ level: "info", event: "notification", type, payload, at: new Date().toISOString() }));
  }
}
