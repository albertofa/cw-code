import type { DeviceCreateResult, DeviceInfo } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, parseString, requireOwner } from "./shared.js";

export function registerDeviceHandlers(router: Router, app: ServerApp): void {
  handle(router, "devices.list", (): DeviceInfo[] => app.deviceInfos());
  handle(router, "devices.create", (params, ctx): DeviceCreateResult => {
    requireOwner(ctx, "devices.create");
    const name = parseString(parseArgs(params, "devices.create").name, "name");
    const { record, token } = app.devices.create(name);
    app.emitDevicesChanged();
    const device = app.deviceInfos().find((info) => info.id === record.id);
    if (!device) throw new Error("created device is missing");
    return { device, token };
  });
  handle(router, "devices.revoke", (params, ctx) => {
    requireOwner(ctx, "devices.revoke");
    app.revokeDevice(parseString(parseArgs(params, "devices.revoke").id, "id"));
  });
}
