# Only allowed media is stored

Phase 3 audit item #5 ("MIME allowlist + magic bytes"). The audit called this
_partially present_, and the machinery it saw is real — but it points the other
way.

## What was there, and why it did not protect anything

`media-library/lib/document-file.ts` reads magic numbers (`%PDF-`, OLE, ZIP)
and has done since documents were moved to R2. It answers:

> is this a **document**? — refuse it, because Cloudinary cannot serve one

That is a **denylist**, and a denylist's default is **allow**. An `.exe`, an
`.svg` carrying `<script>`, an `.html` page, a shell script renamed `cat.jpg` —
none of them is a document, so `looksLikeDocument()` answered false for every
one and the file was stored. `POST media/upload/file` set no `fileFilter` at
all; its `FileInterceptor` limited only `fileSize`.

So the check existed, and the hole existed beside it.

## The inversion

```
denylist (before):  is it a PDF/DOC/ZIP?  → refuse, else STORE
allowlist (now):    is it media we publish? → store, else REFUSE
```

A file must now pass **both**: the document check still runs first, so neither
check relies on the other.

### SVG is the case that makes the default matter

SVG is XML. It has **no magic number at all**, and it is the one image format
that can execute script when served inline. There is nothing to match it
against — so no amount of signature-adding would catch it. Only a
deny-by-default does, and that is what refuses it here.

## The allowlist

Taken from the union of `channels/analytics/platform-capabilities.registry.ts`
— what the platforms themselves accept — rather than invented:

```
images: image/jpeg, image/png, image/webp, image/gif
videos: video/avi, video/mov, video/mp4
```

with corrections and two additions:

- the registry names some types by extension. A `.mov` is **`video/quicktime`**
  (`video/mov` is not a registered type and no sniffer emits it); a `.avi` is
  **`video/x-msvideo`**.
- **`video/webm`** is added: it is in the R2 allowlist
  (`media/cloudflare-r2.service.ts`) and is what the composer's own recordings
  are, so refusing it would reject a file the product itself produces.
- **`image/heic`/`heif`/`avif`** are added for the same reason — R2 takes
  HEIC, and it is what an iPhone photo is by default. Cloudinary converts on
  delivery, so it never reaches a platform as HEIC.

## Why the signatures are hand-written

`file-type` is the standard package for this, and it works correctly in
production — verified: JPEG and MP4 identified, an ELF binary reported as
`application/x-elf`, an SVG as unknown.

It is **ESM-only** from v17, and Jest runs CommonJS in a vm context that
refuses a real `import()` without `--experimental-vm-modules`. Four routes
around that were tried:

| Attempt                                    | Outcome                                           |
| ------------------------------------------ | ------------------------------------------------- |
| `require()` fallback in the loader         | Jest's module registry throws the same error      |
| allow it through `transformIgnorePatterns` | resolves, but the `import()` wall remains         |
| ts-jest `module: commonjs` override        | `TS5098: resolvePackageJsonExports` conflict      |
| also override `moduleResolution`           | same conflict — the project tsconfig is inherited |

What remained was putting the whole suite behind the flag, which touches **661
media-library tests** and every other spec, to add one security check. The
package is small; its toolchain cost is not.

Hand-written instead: **seven checks** cover every allowed format and refuse
ELF, MZ, PDF, SVG, HTML, ZIP and a stray RIFF, with no dependency and no build
configuration to keep working. `document-file.ts` reads magic numbers by hand
in the same directory, so this is the house style rather than an exception.

| Format                  | Signature                 |
| ----------------------- | ------------------------- |
| JPEG                    | `FF D8 FF`                |
| PNG                     | `89 50 4E 47 0D 0A 1A 0A` |
| GIF                     | `GIF87a` / `GIF89a`       |
| WebP                    | `RIFF` + `WEBP` at 8      |
| AVI                     | `RIFF` + `AVI ` at 8      |
| WebM / MKV              | EBML `1A 45 DF A3`        |
| MP4 / MOV / HEIC / AVIF | `ftyp` at 4, brand at 8   |
| MPEG-PS                 | `00 00 01 BA`             |

Two of these carry a detail worth keeping:

- **RIFF is a container.** `RIFF` alone means WebP, AVI _or_ a WAV. A check
  that stopped at the first four bytes would have stored anything RIFF-shaped,
  so the type at offset 8 is read and an unrecognised RIFF is refused.
- **The ISO-BMFF brand separates a photo from a video.** `ftyp` is shared by
  MP4, MOV, HEIC, AVIF and 3GP alike; the brand at offset 8 is what says
  which. `heic`/`mif1`/`avif` are images, `qt` is QuickTime, every other brand
  is treated as MP4.

## Where it runs

Three ingest paths, beside the document check each already had:

| Path                      | Check                                                   |
| ------------------------- | ------------------------------------------------------- |
| `upload/file` (multipart) | bytes sniffed before the quota and before any upload    |
| `upload/base64`           | same, on the decoded head                               |
| `upload/url`              | **after** the upload, on Cloudinary's reported `format` |

The URL path is different because the server never holds the bytes —
Cloudinary fetches them. What exists afterwards is Cloudinary's own verdict: it
decoded the file to store it. That is byte-based evidence gathered by someone
else, and it is the same reasoning `refuseStoredDocument` already uses for a
PDF. The stored copy is deleted before the refusal, so nothing refused is left
behind, and an `existing` asset (someone else's, returned under a taken public
id) is refused without being deleted.

### A declared type that disagrees is logged, not refused

`file.mimetype` is the client's claim, taken from the filename, and a data
URI's prefix is a string the caller wrote. Neither is evidence, so neither
decides anything. But browsers send `application/octet-stream` for a perfectly
good JPEG often enough that _refusing_ on a mismatch would break real uploads.
The bytes decide; the disagreement is logged, because a deliberate one is what
an upload attack looks like. Honest aliases (`image/jpg`, `video/mov`,
`image/heif` for a HEIC) are not treated as disagreements.

## Tests

`media-allowlist.spec.ts` (60) tests the rules; seven tests in
`library-ingest.service.spec.ts` test that each path applies them. **Both were
needed, and the gap was real:** removing the guard from any one of the three
paths left the ingest suite **37/37 green** until those tests existed — the
same shape as the hand-maintained spec that passed 14/14 while two publishing
engines leaked (`deleted-workspace-publishing.md`).

One test asserts a property across both: every format the sniffer accepts has
a counterpart in `ALLOWED_STORED_FORMAT`. Without it a file could pass the byte
check on upload and then be deleted again by the stored check — a maddening bug
to chase.

Mutation-tested:

| Mutation                                                   | Tests that fail |
| ---------------------------------------------------------- | --------------- |
| unknown file passes (deny-by-default removed)              | 12              |
| RIFF accepted without reading its type (a WAV stores)      | 1               |
| ISO image brands dropped (an iPhone photo becomes a video) | 4               |
| `SNIFF_BYTES` back to 16                                   | 1               |
| remove the `upload/file` guard                             | 2               |
| remove the `upload/base64` guard                           | 1               |
| remove the `upload/url` stored check                       | 2               |

### Test fixtures had to become real files

`Buffer.from('hello')` was the shared fixture for "a valid upload", and
`'aGk='` for base64. That was fine while the only byte check was a denylist —
placeholder bytes are not a PDF, so they passed. The allowlist asks the
opposite question, and placeholder bytes are not a PNG either. Fixtures now
carry a real PNG header, with `sizedPng(n)` for the size-cap tests so those
still fail on **size** rather than on the sniffer.

### A claim in the first draft that was wrong

The first version of `base64Head` widened the decoded head from 16 characters
to ~4100 bytes, and its comment said the old width "reads an MP4 as
unrecognised". Measured, that is false: 16 base64 characters decode to exactly
**12 bytes**, and 12 is precisely what the longest signature reads (a RIFF type
or an ISO brand, both at offsets 8–12). The old width worked, with nothing to
spare. The head is now derived from `SNIFF_BYTES` so a signature that ever
needs one more byte does not silently make every video unrecognised — headroom,
not a bug fix, and the comment says so.
