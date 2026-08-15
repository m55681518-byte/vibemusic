import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { isValidId, mp3PathFor, loadMeta } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILENAME_SAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  if (!isValidId(id)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  const filePath = mp3PathFor(id);
  const meta = await loadMeta(id);

  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "private, max-age=300",
    "Accept-Ranges": "bytes",
  };
  if (meta && req.nextUrl.searchParams.get("download") === "1") {
    const fname = (meta.title || "vibemusic-track").replace(FILENAME_SAFE, "_");
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(fname)}.mp3`;
  }

  let size = 0;
  try {
    ({ size } = await stat(filePath));
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      end = Math.min(end, size - 1);
      const length = end - start + 1;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = String(length);
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
      return new NextResponse(stream as unknown as BodyInit, { status: 206, headers });
    }
  }

  headers["Content-Length"] = String(size);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream as unknown as BodyInit, { status: 200, headers });
}