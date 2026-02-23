/*
 * libdmtx wrapper for Emscripten
 *
 * Exports:
 *   char* scanImageBuffer(uint8_t *rgba, int width, int height)
 *
 * Returns a malloc()'d C string containing a JSON array of detections.
 * Each detection is an object with at least a `data` string field.
 * The JS glue is responsible for freeing the returned pointer.
 *
 * Notes:
 * - This implementation uses the libdmtx C API. Link with -ldmtx when
 *   compiling (see vendor/build_libdmtx.ps1).
 * - The routine uses a single decode pass (dmtxDecodeMatrix). It returns
 *   the first decoded message if any. You can extend it to iterate over
 *   regions if desired.
 */

#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <dmtx.h>

// Helper: allocate and duplicate a C string
static char* strdup_malloc(const char *s) {
  if (!s) return NULL;
  size_t n = strlen(s) + 1;
  char *p = (char*)malloc(n);
  if (!p) return NULL;
  memcpy(p, s, n);
  return p;
}

char* scanImageBuffer(uint8_t *rgba, int width, int height) {
  if (!rgba || width <= 0 || height <= 0) {
    return strdup_malloc("[]");
  }

  // Create libdmtx image from raw RGBA buffer. Pack format: RGBX (32bpp)
  DmtxImage *img = dmtxImageCreate((const unsigned char*)rgba, width, height, DmtxPack32bppRGBX);
  if (!img) return strdup_malloc("[]");

  DmtxDecode *dec = dmtxDecodeCreate(img, 1);
  if (!dec) { dmtxImageDestroy(&img); return strdup_malloc("[]"); }

  DmtxMessage *msg = dmtxDecodeMatrix(dec, NULL);
  if (!msg) {
    dmtxDecodeDestroy(&dec);
    dmtxImageDestroy(&img);
    return strdup_malloc("[]");
  }

  // msg->output points to the decoded bytes, msg->output->byte may be used
  // but the public API exposes output and outputLength in many builds.
  // We'll defensively handle common fields.
  const char *outStr = NULL;
  int outLen = 0;
  if (msg->output != NULL) {
    outStr = (const char*)msg->output;
    outLen = (int)strlen(outStr);
  } else if (msg->outputLength > 0 && msg->output != NULL) {
    outStr = (const char*)msg->output;
    outLen = msg->outputLength;
  }

  char *json = NULL;
  if (outStr && outLen > 0) {
    // build simple JSON with escaped data field
    // allocate a buffer (roughly 2x outLen + overhead)
    size_t bufSize = (size_t)outLen * 2 + 64;
    json = (char*)malloc(bufSize);
    if (!json) json = strdup_malloc("[]");
    else {
      char *p = json;
      *p++ = '['; *p++ = '{';
      strcpy(p, "\"data\":\""); p += strlen("\"data\":\"");
      // simple escaping of backslash and quote
      for (int i = 0; i < outLen; ++i) {
        char c = outStr[i];
        if (c == '\\' || c == '"') { *p++ = '\\'; *p++ = c; }
        else if ((unsigned char)c >= 32) { *p++ = c; }
        else { *p++ = '?'; }
      }
      strcpy(p, "\"}"); p += 2;
      *p++ = ']'; *p = '\0';
    }
  } else {
    json = strdup_malloc("[]");
  }

  dmtxMessageDestroy(&msg);
  dmtxDecodeDestroy(&dec);
  dmtxImageDestroy(&img);

  return json;
}
