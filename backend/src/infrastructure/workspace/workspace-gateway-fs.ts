import { promises as nodeFs } from 'node:fs';

export interface WorkspaceGatewayStats {
  readonly size?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface WorkspaceGatewayFileHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}

export interface WorkspaceGatewayFileSystem {
  lstat(filePath: string): Promise<WorkspaceGatewayStats>;
  realpath(filePath: string): Promise<string>;
  readDirectory(directoryPath: string): Promise<readonly string[]>;
  iterateDirectory?(directoryPath: string): AsyncIterable<string>;
  openRead(filePath: string): Promise<WorkspaceGatewayFileHandle>;
}

export const defaultWorkspaceGatewayFileSystem: WorkspaceGatewayFileSystem = {
  lstat: (filePath) => nodeFs.lstat(filePath),
  realpath: (filePath) => nodeFs.realpath(filePath),
  readDirectory: async (directoryPath) => nodeFs.readdir(directoryPath),
  iterateDirectory: async function* (directoryPath) {
    const directory = await nodeFs.opendir(directoryPath);
    for await (const entry of directory) {
      yield entry.name;
    }
  },
  openRead: async (filePath) => {
    const handle = await nodeFs.open(filePath, 'r');
    return {
      read: async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead,
      close: () => handle.close()
    };
  }
};

export function isWorkspaceReparsePoint(stats: WorkspaceGatewayStats): boolean {
  return stats.isSymbolicLink() || stats.isReparsePoint?.() === true;
}
