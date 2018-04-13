// @flow

import browser from '../util/browser';

import pixelsToTileUnits from '../source/pixels_to_tile_units';
import DepthMode from '../gl/depth_mode';
import Texture from './texture';

import type Painter from './painter';
import type SourceCache from '../source/source_cache';
import type LineStyleLayer from '../style/style_layer/line_style_layer';
import type LineBucket from '../data/bucket/line_bucket';
import type {OverscaledTileID} from '../source/tile_id';

export default function drawLine(painter: Painter, sourceCache: SourceCache, layer: LineStyleLayer, coords: Array<OverscaledTileID>) {
    if (painter.renderPass !== 'translucent') return;

    const opacity = layer.paint.get('line-opacity');
    const width = layer.paint.get('line-width');
    if (opacity.constantOr(1) === 0 || width.constantOr(1) === 0) return;

    const context = painter.context;
    context.setDepthMode(painter.depthModeForSublayer(0, DepthMode.ReadOnly));
    context.setColorMode(painter.colorModeForRenderPass());

    const linePattern = layer.paint.get('line-pattern');
    const programId =
        layer.paint.get('line-dasharray') ? 'lineSDF' :
        linePattern && linePattern.property.getPossibleOutputs().length ? 'linePattern' :
        layer.paint.get('line-gradient') ? 'lineGradient' : 'line';

    let prevTileZoom;
    let firstTile = true;
    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);

        const pattern = linePattern.constantOr((1: any));
        if (pattern && !tile.iconAtlas) continue;
        if (pattern && tile.iconAtlas) {
            // pattern is set, but the icon atlas hasn't been populated yet
            if (!Object.keys(tile.iconAtlas.positions).length) continue;
            if (pattern.to && pattern.from) {
                const imagePosFrom = tile.iconAtlas.positions[pattern.from],
                    imagePosTo = tile.iconAtlas.positions[pattern.to];
                if (!imagePosFrom || !imagePosTo) continue;
            }
        }

        const bucket: ?LineBucket = (tile.getBucket(layer): any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const prevProgram = painter.context.program.get();
        const program = painter.useProgram(programId, programConfiguration);
        const programChanged = firstTile || program.program !== prevProgram;
        const tileRatioChanged = prevTileZoom !== tile.tileID.overscaledZ;

        if (programChanged) {
            programConfiguration.setUniforms(painter.context, program, layer.paint, {zoom: painter.transform.zoom});
        }
        drawLineTile(program, painter, tile, bucket, layer, coord, programConfiguration, programChanged, tileRatioChanged);
        prevTileZoom = tile.tileID.overscaledZ;
        firstTile = false;
    }
}

function drawLineTile(program, painter, tile, bucket, layer, coord, programConfiguration, programChanged, tileRatioChanged) {
    const context = painter.context;
    const gl = context.gl;
    const dasharray = layer.paint.get('line-dasharray');
    let posA, posB;
    const tileRatio = 1 / pixelsToTileUnits(tile, 1, painter.transform.tileZoom);
    const crossfade = layer.getCrossfadeParameters();
    programConfiguration.updatePatternPaintBuffers(crossfade);
    programConfiguration.setTileSpecificUniforms(painter.context,
                                                 program,
                                                 layer.paint,
                                                 {zoom: painter.transform.zoom},
                                                 painter.transform.tileZoom,
                                                 tile,
                                                 crossfade);
    if (programChanged || tileRatioChanged) {
        if (dasharray) {
            posA = painter.lineAtlas.getDash(dasharray.from, layer.layout.get('line-cap') === 'round');
            posB = painter.lineAtlas.getDash(dasharray.to, layer.layout.get('line-cap') === 'round');

            const widthA = posA.width * dasharray.fromScale;
            const widthB = posB.width * dasharray.toScale;

            gl.uniform2f(program.uniforms.u_patternscale_a, tileRatio / widthA, -posA.height / 2);
            gl.uniform2f(program.uniforms.u_patternscale_b, tileRatio / widthB, -posB.height / 2);
            gl.uniform1f(program.uniforms.u_sdfgamma, painter.lineAtlas.width / (Math.min(widthA, widthB) * 256 * browser.devicePixelRatio) / 2);
        }

        gl.uniform2f(program.uniforms.u_gl_units_to_pixels, 1 / painter.transform.pixelsToGLUnits[0], 1 / painter.transform.pixelsToGLUnits[1]);
    }

    if (programChanged && dasharray) {
        gl.uniform1i(program.uniforms.u_image, 0);
        context.activeTexture.set(gl.TEXTURE0);
        painter.lineAtlas.bind(context);

        gl.uniform1f(program.uniforms.u_tex_y_a, (posA: any).y);
        gl.uniform1f(program.uniforms.u_tex_y_b, (posB: any).y);
        gl.uniform1f(program.uniforms.u_mix, dasharray.t);
    }

    context.setStencilMode(painter.stencilModeForClipping(coord));

    const posMatrix = painter.translatePosMatrix(coord.posMatrix, tile, layer.paint.get('line-translate'), layer.paint.get('line-translate-anchor'));
    gl.uniformMatrix4fv(program.uniforms.u_matrix, false, posMatrix);
    gl.uniform1f(program.uniforms.u_ratio, 1 / pixelsToTileUnits(tile, 1, painter.transform.zoom));

    if (layer.paint.get('line-gradient')) {
        context.activeTexture.set(gl.TEXTURE0);

        let gradientTexture = layer.gradientTexture;
        if (!layer.gradient) return;
        if (!gradientTexture) gradientTexture = layer.gradientTexture = new Texture(context, layer.gradient, gl.RGBA);
        gradientTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

        gl.uniform1i(program.uniforms.u_image, 0);
    }

    program.draw(
        context,
        gl.TRIANGLES,
        layer.id,
        bucket.layoutVertexBuffer,
        bucket.indexBuffer,
        bucket.segments,
        programConfiguration);
}
