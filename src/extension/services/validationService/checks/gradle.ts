// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as nls from "vscode-nls";
import {
    basicCheck,
    createNotFoundMessage,
    createVersionErrorMessage,
    parseVersion,
} from "../util";
import { ValidationCategoryE, IValidation, ValidationResultT } from "./types";

nls.config({
    messageFormat: nls.MessageFormat.bundle,
    bundleFormat: nls.BundleFormat.standalone,
})();

const toLocale = nls.loadMessageBundle();

const label = "Gradle";

async function test(): Promise<ValidationResultT> {
    const result = await basicCheck({
        command: "gradle",
        getVersion: parseVersion.bind(null, "gradle -version", /gradle (.*?)( |$)/gim),
    });

    if (!result.exists) {
        return {
            status: "failure",
            comment: createNotFoundMessage(label),
        };
    }

    if (result.versionCompare === undefined) {
        return {
            status: "failure",
            comment: createVersionErrorMessage(label),
        };
    }

    return {
        status: "success",
    };
}

const main: IValidation = {
    label,
    description: toLocale("GradleTestDescription", "Requried for building android apps"),
    category: ValidationCategoryE.Android,
    exec: test,
};

export default main;
