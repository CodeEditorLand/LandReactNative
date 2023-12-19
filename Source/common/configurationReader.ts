// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { ErrorHelper } from "./error/errorHelper";
import { InternalErrorCode } from "./error/internalErrorCode";

export class ConfigurationReader {
	public static readString(value: any): string {
		if (ConfigurationReader.isString(value)) {
			return value;
		}
		throw ErrorHelper.getInternalError(
			InternalErrorCode.ExpectedStringValue,
			value,
		);
	}

	public static readBoolean(value: any): boolean {
		if (ConfigurationReader.isBoolean(value)) {
			return value;
		} else if (value === "true" || value === "false") {
			return value === "true";
		}
		throw ErrorHelper.getInternalError(
			InternalErrorCode.ExpectedBooleanValue,
			value,
		);
	}

	public static readArray(value: any): any[] {
		if (ConfigurationReader.isArray(value)) {
			return value;
		}
		throw ErrorHelper.getInternalError(
			InternalErrorCode.ExpectedArrayValue,
			value,
		);
	}

	public static readObject(value: any): Record<string, any> {
		if (ConfigurationReader.isObject(value)) {
			return value;
		}
		throw ErrorHelper.getInternalError(
			InternalErrorCode.ExpectedObjectValue,
			value,
		);
	}

	/* We try to read an integer. It can be either an integer, or a string that can be parsed as an integer */
	public static readInt(value: any): number {
		if (ConfigurationReader.isInt(value)) {
			return value;
		} else if (ConfigurationReader.isString(value)) {
			return parseInt(value, 10);
		}
		throw ErrorHelper.getInternalError(
			InternalErrorCode.ExpectedIntegerValue,
			value,
		);
	}

	/* We try to read an integer. If it's a falsable value we return the default value, if not we behave like this.readInt(value)
      If the value is provided but it can't be parsed we'll throw an exception so the user knows that we didn't understand
      the value that was provided */
	public static readIntWithDefaultSync(
		value: any,
		defaultValue: number,
	): number {
		return value ? ConfigurationReader.readInt(value) : defaultValue;
	}

	public static async readIntWithDefaultAsync(
		value: any,
		defaultValuePromise: Promise<number>,
	): Promise<number> {
		const defaultValue = await defaultValuePromise;
		return ConfigurationReader.readIntWithDefaultSync(value, defaultValue);
	}

	private static isArray(value: any): boolean {
		return Array.isArray(value);
	}

	private static isObject(value: any): boolean {
		return typeof value === "object" || !ConfigurationReader.isArray(value);
	}

	private static isString(value: any): boolean {
		return typeof value === "string";
	}

	private static isBoolean(value: any): boolean {
		return typeof value === "boolean";
	}

	private static isInt(value: any): boolean {
		return ConfigurationReader.isNumber(value) && value % 1 === 0;
	}

	private static isNumber(value: any): boolean {
		return typeof value === "number";
	}
}
