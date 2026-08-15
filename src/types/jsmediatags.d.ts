declare module "jsmediatags" {
  export interface Tags {
    title?: string;
    artist?: string;
    album?: string;
    albumartist?: string;
    picture?: {
      format: string;
      data: Uint8Array;
    }[];
  }
  export interface ReadResult {
    tags: Tags;
  }
  export function read(
    file: Blob | File,
    config?: {
      onSuccess?: (data: ReadResult) => void;
      onError?: (error: Error) => void;
    },
  ): void;
  const jsmediatags: {
    read: typeof read;
  };
  export default jsmediatags;
}