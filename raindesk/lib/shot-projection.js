'use strict';

/**
 * Deterministic ShotDocument -> flat PNG projection for production adapters.
 *
 * Production tools need pixels, but Raindesk's authority is the immutable
 * layered ShotDocument revision. This module resolves that revision, verifies
 * every referenced raster blob by content hash, replays vector strokes through
 * the same DOM-free canvas core used by the browser, and returns a deterministic
 * flattened PNG. It never accepts caller-supplied panel pixels or paths.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { HttpError } = require('./errors');
const blobs = require('./blobs');
const shotDocuments = require('./shot-documents');
const Canvas = require('../public/js/canvas');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function resolveRevision(shotId, revisionId = null) {
  const revision = revisionId
    ? shotDocuments.readRevision(shotId, revisionId)
    : shotDocuments.readCurrent(shotId);
  if (!revision) throw new HttpError(404, `shot ${shotId} has no editable artwork revision`);
  return revision;
}

function loadRasterBuffer(layer, width, height) {
  const file = blobs.resolve(layer.assetSha);
  if (!file) throw new HttpError(500, `shot raster blob ${layer.assetSha} is missing`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== layer.assetSha) {
    throw new HttpError(500, `shot raster blob ${layer.assetSha} failed its content hash`);
  }
  let decoded;
  try {
    decoded = Canvas.decodePNG(bytes);
  } catch (error) {
    throw new HttpError(422, `shot raster blob ${layer.assetSha} cannot be projected: ${error.message}`);
  }
  if (decoded.width !== width || decoded.height !== height) {
    throw new HttpError(500, `shot raster blob ${layer.assetSha} dimensions do not match its document`);
  }
  return decoded.data;
}

function projectRevision(shotId, revisionId = null) {
  const revision = resolveRevision(shotId, revisionId);
  const doc = revision.document;
  const width = Number(doc && doc.canvas && doc.canvas.width);
  const height = Number(doc && doc.canvas && doc.canvas.height);
  const core = new Canvas.RainCanvasCore({ width, height });
  const layerBuffers = Object.create(null);

  for (const layer of doc.layers || []) {
    if (!Canvas.isRasterKind(layer.kind)) continue;
    layerBuffers[layer.id] = loadRasterBuffer(layer, width, height);
  }

  try {
    core.loadDocument(doc, layerBuffers);
  } catch (error) {
    throw new HttpError(500, `shot revision ${revision.revisionId} cannot be projected: ${error.message}`);
  }
  const flat = core.compositeVisible();
  const png = Buffer.from(Canvas.encodePNG(width, height, flat.data));
  return Object.freeze({
    shotId,
    revisionId: revision.revisionId,
    width,
    height,
    png,
    panelSha: sha256(png),
  });
}

module.exports = { sha256, resolveRevision, loadRasterBuffer, projectRevision };
