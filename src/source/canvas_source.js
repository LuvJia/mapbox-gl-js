// @flow

import ImageSource from './image_source';

import window from '../util/window';
import rasterBoundsAttributes from '../data/raster_bounds_attributes';
import SegmentVector from '../data/segment';
import Texture from '../render/texture';
import { ErrorEvent } from '../util/evented';
import ValidationError from '../style-spec/error/validation_error';

import type Map from '../ui/map';
import type Dispatcher from '../util/dispatcher';
import type {Evented} from '../util/evented';

export type CanvasSourceSpecification = {|
    "type": "canvas",
    "coordinates": [[number, number], [number, number], [number, number], [number, number]],
    "animate"?: boolean,
    "canvas": string | HTMLCanvasElement
|};

/**
 * 添加canvas类型的数据源到地图上的参数说明.
 *
 * @typedef {Object} CanvasSourceOptions
 * @property {string} type 数据源类型. 必须是`canvas`类型.
 * @property {string|HTMLCanvasElement} canvas 从中读取像素的 `canvas` 数据源. 可以是一个表示 `canvas` 元素ID的字符串,或者是 `HTMLCanvasElement` 本身.
 * @property {Array<Array<number>>} coordinates 四组表示 `canvas` 范围的坐标对,形式为 `[经度, 纬度]` .
 * @property {boolean} [animate=true] `canvas` 数据源是否开启动画. 如果 `canvas` 是静态的(每一帧所有的像素没有必要重新读取),请把动画选项 `animate` 设置成false,以便提升性能.
 */

/**
 * 包含 `canvas` 的数据源. 请看 {@link CanvasSourceOptions} 更详细的文档描述.
 *
 * @example
 * // 添加数据到map
 * map.addSource('some id', {
 *    type: 'canvas',
 *    canvas: 'idOfMyHTMLCanvas',
 *    animate: true,
 *    coordinates: [
 *        [-76.54, 39.18],
 *        [-76.52, 39.18],
 *        [-76.52, 39.17],
 *        [-76.54, 39.17]
 *    ]
 * });
 *
 * // 更新数据源
 * var mySource = map.getSource('some id');
 * mySource.setCoordinates([
 *     [-76.54335737228394, 39.18579907229748],
 *     [-76.52803659439087, 39.1838364847587],
 *     [-76.5295386314392, 39.17683392507606],
 *     [-76.54520273208618, 39.17876344106642]
 * ]);
 *
 * map.removeSource('some id');  // 移除
 */
class CanvasSource extends ImageSource {
    options: CanvasSourceSpecification;
    animate: boolean;
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    play: () => void;
    pause: () => void;
    _playing: boolean;

    /**
     * @private
     */
    constructor(id: string, options: CanvasSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super(id, options, dispatcher, eventedParent);

        // 验证,因为样式规格不包含canvas数据源:
        if (!options.coordinates) {
            this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, 'missing required property "coordinates"')));
        } else if (!Array.isArray(options.coordinates) || options.coordinates.length !== 4 ||
            options.coordinates.some(c => !Array.isArray(c) || c.length !== 2 || c.some(l => typeof l !== 'number'))) {
            this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, '"coordinates" property must be an array of 4 longitude/latitude array pairs')));
        }

        if (options.animate && typeof options.animate !== 'boolean') {
            this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, 'optional "animate" property must be a boolean value')));
        }

        if (!options.canvas) {
            this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, 'missing required property "canvas"')));
        } else if (typeof options.canvas !== 'string' && !(options.canvas instanceof window.HTMLCanvasElement)) {
            this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, '"canvas" must be either a string representing the ID of the canvas element from which to read, or an HTMLCanvasElement instance')));
        }

        this.options = options;
        this.animate = options.animate !== undefined ? options.animate : true;
    }

    /**
     * 开启动画. 地图上的每一帧图像都是从 `canvas` 的一个拷贝.
     * @method play
     * @instance
     * @memberof CanvasSource
     */

    /**
     * 关闭动画. 地图上将展示一个静态的canvas图像的拷贝.
     * @method pause
     * @instance
     * @memberof CanvasSource
     */

    load() {
        if (!this.canvas) {
            this.canvas = (this.options.canvas instanceof window.HTMLCanvasElement) ?
                this.options.canvas :
                window.document.getElementById(this.options.canvas);
        }
        this.width = this.canvas.width;
        this.height = this.canvas.height;

        if (this._hasInvalidDimensions()) {
            this.fire(new ErrorEvent(new Error('Canvas dimensions cannot be less than or equal to zero.')));
            return;
        }

        this.play = function() {
            this._playing = true;
            this.map._rerender();
        };

        this.pause = function() {
            this._playing = false;
        };

        this._finishLoading();
    }

    /**
     * 返回HTML `canvas` 元素.
     *
     * @returns {HTMLCanvasElement} HTML `canvas` 元素.
     */
    getCanvas() {
        return this.canvas;
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
        if (this.canvas) {
            if (this.animate) this.play();
        }
    }

    onRemove() {
        this.pause();
    }

    /**
     * 设置canvas的坐标并重新渲染地图.
     *
     * @method setCoordinates
     * @instance
     * @memberof CanvasSource
     * @param {Array<Array<number>>} coordinates 四组地理坐标对构成的集合,
     *   每一组坐标是由经纬度构成的数组,四组坐标对表示了 `canvas` 的地理空间范围.
     *   从左上角开始,按照顺时针.
     *   并不一定是矩形.
     * @returns {CanvasSource} this
     */
    // setCoordinates 方法继承于 ImageSource

    prepare() {
        let resize = false;
        if (this.canvas.width !== this.width) {
            this.width = this.canvas.width;
            resize = true;
        }
        if (this.canvas.height !== this.height) {
            this.height = this.canvas.height;
            resize = true;
        }

        if (this._hasInvalidDimensions()) return;

        if (Object.keys(this.tiles).length === 0) return; // 当前位置没有数据

        const context = this.map.painter.context;
        const gl = context.gl;

        if (!this.boundsBuffer) {
            this.boundsBuffer = context.createVertexBuffer(this._boundsArray, rasterBoundsAttributes.members);
        }

        if (!this.boundsSegments) {
            this.boundsSegments = SegmentVector.simpleSegment(0, 0, 4, 2);
        }

        if (!this.texture) {
            this.texture = new Texture(context, this.canvas, gl.RGBA);
            this.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
        } else if (resize) {
            this.texture.update(this.canvas);
        } else if (this._playing) {
            this.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
        }

        for (const w in this.tiles) {
            const tile = this.tiles[w];
            if (tile.state !== 'loaded') {
                tile.state = 'loaded';
                tile.texture = this.texture;
            }
        }
    }

    serialize(): Object {
        return {
            type: 'canvas',
            coordinates: this.coordinates
        };
    }

    hasTransition() {
        return this._playing;
    }

    _hasInvalidDimensions() {
        for (const x of [this.canvas.width, this.canvas.height]) {
            if (isNaN(x) || x <= 0) return true;
        }
        return false;
    }
}

export default CanvasSource;
