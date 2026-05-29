import { filters } from "fabric";

const TEMP_WARM = "#ffb45f";
const TEMP_COOL = "#72b7ff";

const CONFIGS = [
  { key: "brightness", defaultValue: 0, filterClass: filters.Brightness, valueKey: "brightness", toFilterValue: (v) => v / 100 },
  { key: "contrast", defaultValue: 0, filterClass: filters.Contrast, valueKey: "contrast", toFilterValue: (v) => v / 100 },
  { key: "gamma", defaultValue: 100, filterClass: filters.Gamma, toFilterOptions: (v) => ({ gamma: [v / 100, v / 100, v / 100] }) },
  { key: "temperature", defaultValue: 0, filterClass: filters.BlendColor, toFilterOptions: (v) => ({ color: v >= 0 ? TEMP_WARM : TEMP_COOL, mode: "tint", alpha: Math.abs(v) / 280 }) },
  { key: "saturation", defaultValue: 0, filterClass: filters.Saturation, valueKey: "saturation", toFilterValue: (v) => v / 100 },
  { key: "vibrance", defaultValue: 0, filterClass: filters.Vibrance, valueKey: "vibrance", toFilterValue: (v) => v / 100 },
  { key: "hue", defaultValue: 0, filterClass: filters.HueRotation, valueKey: "rotation", toFilterValue: (v) => v / 180 },
  {
    key: "sharpness",
    defaultValue: 0,
    filterClass: filters.Convolute,
    toFilterOptions: (v) => {
      const amount = v / 100;
      return { opaque: false, matrix: [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0] };
    },
  },
  { key: "blur", defaultValue: 0, filterClass: filters.Blur, valueKey: "blur", toFilterValue: (v) => v / 100 },
  { key: "noise", defaultValue: 0, filterClass: filters.Noise, valueKey: "noise", toFilterValue: (v) => v * 6 },
  { key: "pixelate", defaultValue: 1, filterClass: filters.Pixelate, valueKey: "blocksize", toFilterValue: (v) => v },
];

const isAgentFilter = (filter) => filter?._pixxelAgentFilter === true;

const buildProfessionalFilters = (adjustments = {}) =>
  CONFIGS.reduce((acc, config) => {
    const value = Number(adjustments[config.key] ?? config.defaultValue);
    if (value === config.defaultValue) return acc;

    const options = config.toFilterOptions
      ? config.toFilterOptions(value)
      : { [config.valueKey]: config.toFilterValue(value) };
    const filter = new config.filterClass(options);
    filter._pixxelAgentFilter = true;
    filter._pixxelAdjustmentKey = config.key;
    acc.push(filter);
    return acc;
  }, []);

export const applyProfessionalFilters = (imageObject, adjustments = {}) => {
  if (!imageObject) return false;
  const current = imageObject.filters || [];
  const preserved = current.filter((filter) => !isAgentFilter(filter));
  imageObject.filters = [...preserved, ...buildProfessionalFilters(adjustments)];
  imageObject.applyFilters?.();
  imageObject.set?.("dirty", true);
  return true;
};
