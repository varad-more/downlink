// Adapted from deck.gl's TripsLayer.
// Copyright (c) 2015-2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import type { AccessorFunction, DefaultProps } from "@deck.gl/core";
import { PathLayer, type PathLayerProps } from "@deck.gl/layers";

type TimestampArray = number[] | Float32Array | Float64Array;
type TripProps<DataT> = {
  fadeTrail?: boolean;
  trailLength?: number;
  currentTime?: number;
  getTimestamps?: AccessorFunction<DataT, TimestampArray>;
};
type TripsLayerProps<DataT = unknown> = TripProps<DataT> & PathLayerProps<DataT>;

const defaultProps: DefaultProps<TripsLayerProps> = {
  fadeTrail: true,
  trailLength: { type: "number", value: 120, min: 0 },
  currentTime: { type: "number", value: 0, min: 0 },
  getTimestamps: { type: "accessor", value: (item: any) => item.timestamps },
};

/** Animated PathLayer without importing geo-layers and its unused image stack. */
export class TripsLayer<DataT = any> extends PathLayer<
  DataT,
  Required<TripProps<DataT>>
> {
  static layerName = "TripsLayer";
  static defaultProps = defaultProps;

  getShaders() {
    const shaders = super.getShaders();
    shaders.inject = {
      "vs:#decl": `
uniform float trailLength;
in float instanceTimestamps;
in float instanceNextTimestamps;
out float vTime;
`,
      "vs:#main-end": `
vTime = instanceTimestamps + (instanceNextTimestamps - instanceTimestamps) * vPathPosition.y / vPathLength;
`,
      "fs:#decl": `
uniform bool fadeTrail;
uniform float trailLength;
uniform float currentTime;
in float vTime;
`,
      "fs:#main-start": `
if (vTime > currentTime || (fadeTrail && vTime < currentTime - trailLength)) {
  discard;
}
`,
      "fs:DECKGL_FILTER_COLOR": `
if (fadeTrail) {
  color.a *= 1.0 - (currentTime - vTime) / trailLength;
}
`,
    };
    return shaders;
  }

  initializeState() {
    super.initializeState();
    this.getAttributeManager()!.addInstanced({
      timestamps: {
        size: 1,
        accessor: "getTimestamps",
        shaderAttributes: {
          instanceTimestamps: { vertexOffset: 0 },
          instanceNextTimestamps: { vertexOffset: 1 },
        },
      },
    });
  }

  draw(params: any) {
    const { fadeTrail, trailLength, currentTime } = this.props;
    params.uniforms = {
      ...params.uniforms,
      fadeTrail,
      trailLength,
      currentTime,
    };
    super.draw(params);
  }
}
