import { AndroidDriver } from "./android.js";
import { IosDriver } from "./ios.js";
import type { Device, Driver, Platform } from "./types.js";

const IOS_UDID = /^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;

/**
 * Owns the two platform drivers and routes a device id to the right one.
 * iOS simulator UDIDs are UUIDs; everything else is treated as an adb serial.
 */
export class DriverRegistry {
  readonly android = new AndroidDriver();
  readonly ios = new IosDriver();

  platformOf(deviceId: string): Platform {
    return IOS_UDID.test(deviceId) ? "ios" : "android";
  }

  driverFor(deviceId: string): Driver {
    return this.platformOf(deviceId) === "ios" ? this.ios : this.android;
  }

  async listAllDevices(): Promise<Device[]> {
    const [android, ios] = await Promise.all([
      this.android.listDevices().catch(() => []),
      this.ios.listDevices().catch(() => []),
    ]);
    return [...android, ...ios];
  }

  /** Find the full Device record for an id, if currently connected. */
  async resolveDevice(deviceId: string): Promise<Device | undefined> {
    const all = await this.listAllDevices();
    return all.find((d) => d.id === deviceId);
  }
}
