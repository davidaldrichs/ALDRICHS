/** preload 在桌面(Electron)里注入的 window.desktop 接口 */
export interface SerialPortItem {
  portId: string;
  portName: string;
}

export interface DesktopApi {
  isDesktop: boolean;
  platform: string;
  chooseSerialPort(portId: string): void;
  onSerialList(cb: (list: SerialPortItem[]) => void): void;
  tcpConnect(host: string, port: number): Promise<number>;
  tcpWrite(id: number, data: string): void;
  tcpClose(id: number): void;
  onTcpData(cb: (m: { id: number; data: string }) => void): void;
  onTcpClose(cb: (m: { id: number }) => void): void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export const desktop = (): DesktopApi | undefined => window.desktop;
export const isDesktop = (): boolean => !!window.desktop?.isDesktop;
