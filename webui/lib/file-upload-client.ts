import { encodeFilePathForApi } from './file-paths';

/** Browser side of `POST /api/files/[...path]?type=upload`; mirrors `lib/file-upload.ts`. */
export type UploadConflictStrategy = 'error' | 'overwrite' | 'skip';

export interface UploadError {
  name: string;
  error: string;
}

export interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

/**
 * Uploads files into one directory through the file API.
 * @param targetDirectory The directory the files are written to
 * @param files The files, written under their own names
 * @param strategy What the server does with a name that already exists
 * @param onProgress Upload progress in percent, when the browser reports it
 * @returns The HTTP status and the parsed response body
 */
export function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress?: (progress: number) => void
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`
    );
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error('Network error while uploading files'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

/** One file or folder dropped onto the chat. */
export type DroppedItem = { kind: 'file'; file: File } | { kind: 'folder'; name: string };

/**
 * Sorts a chat drop: every file, images included, uploads into the working
 * directory and attaches as chips. Folders are left out because a browser drop
 * only names them; nothing of their contents reaches the page.
 * @param items The dropped items, in drop order
 * @returns The files to upload and the names of skipped folders
 */
export function splitDroppedItems(items: DroppedItem[]): {
  files: File[];
  folders: string[];
} {
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of items) {
    if (item.kind === 'folder') folders.push(item.name);
    else files.push(item.file);
  }
  return { files, folders };
}

const PASTED_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
};

/**
 * Whether a name is the generic one browsers give a raw clipboard image, such
 * as a screenshot's `image.png`. Files copied in a file manager keep real names.
 */
function isGenericImageName(name: string, mimeType: string): boolean {
  const extension = PASTED_IMAGE_EXTENSIONS[mimeType];
  if (!extension) return false;
  return name.toLowerCase() === `image.${extension}`;
}

/** A timestamped name one paste can call its own, so two screenshots never collide. */
function pastedImageName(mimeType: string, sequence: number): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 19);
  const extension = PASTED_IMAGE_EXTENSIONS[mimeType] ?? 'png';
  return `pasted-${stamp}-${sequence}.${extension}`;
}

/**
 * Names clipboard screenshots before their upload. Browsers call every pasted
 * screenshot `image.png`, so a second paste would collide with the first one
 * in the working directory and the chip would reference the wrong picture.
 * Files copied in a file manager keep their own names: they already have real
 * ones.
 * @param files The files taken from a paste event
 * @returns The same files; screenshots carry a fresh, distinctive name
 */
export function namePastedFiles(files: File[]): File[] {
  let sequence = 0;
  return files.map((file) => {
    if (!file.type.startsWith('image/')) return file;
    if (!isGenericImageName(file.name, file.type)) return file;
    sequence += 1;
    return new File([file], pastedImageName(file.type, sequence), {
      type: file.type,
      lastModified: file.lastModified
    });
  });
}

/**
 * The working-directory paths of the dropped files the upload reported, in drop
 * order. They become the composer's attachment chips.
 * @param files The dropped files
 * @param present Names the upload reports as written or already there
 * @returns Relative paths, or an empty list
 */
export function dropMentionPaths(files: File[], present: string[]): string[] {
  const names = new Set(present);
  return files.filter((file) => names.has(file.name)).map((file) => file.name);
}
