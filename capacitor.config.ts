import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aldrichs.minirtool',
  appName: 'MINI R 诊断',
  webDir: 'dist',
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: '正在搜索 OBD 蓝牙设备…',
        cancel: '取消',
        availableDevices: '可用设备',
        noDeviceFound: '没有找到设备',
      },
    },
  },
};

export default config;
