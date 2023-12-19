// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

/* eslint-disable */
/* eslint-enable prettier/prettier*/

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as mkdirp from "mkdirp";
import * as tmp from "tmp-promise";
import { v4 as uuid } from "uuid";
import * as nls from "vscode-nls";
import { FileSystem as fsUtils } from "../../common/node/fileSystem";
import {
	isInstalled as opensslInstalled,
	openssl,
} from "../../common/opensslWrapperWithPromises";
import { AdbHelper } from "../android/adb";
import * as androidUtil from "../android/androidContainerUtility";
import iosUtil from "../ios/iOSContainerUtility";
import { OutputChannelLogger } from "../log/OutputChannelLogger";
import { ClientOS } from "./clientUtils";
import { NETWORK_INSPECTOR_LOG_CHANNEL_NAME } from "./networkInspectorServer";
nls.config({
	messageFormat: nls.MessageFormat.bundle,
	bundleFormat: nls.BundleFormat.standalone,
})();
const localize = nls.loadMessageBundle();

/**
 * @preserve
 * Start region: the code is borrowed from https://github.com/facebook/flipper/blob/v0.79.1/desktop/app/src/utils/CertificateProvider.tsx
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

export type CertificateExchangeMedium = "FS_ACCESS" | "WWW";

// Desktop file paths
const caKey = getFilePath("ca.key");
const caCert = getFilePath("ca.crt");
const serverKey = getFilePath("server.key");
const serverCsr = getFilePath("server.csr");
const serverSrl = getFilePath("server.srl");
const serverCert = getFilePath("server.crt");

// Device file paths
const csrFileName = "app.csr";
const deviceCAcertFile = "sonarCA.crt";
const deviceClientCertFile = "device.crt";

const caSubject = "/C=US/ST=CA/L=Redmond/O=Microsoft/CN=ReactNativeExtensionCA";
const serverSubject = "/C=US/ST=CA/L=Redmond/O=Microsoft/CN=localhost";
const minCertExpiryWindowSeconds = 24 * 60 * 60;
const allowedAppNameRegex = /^[\w.-]+$/;

/*
 * RFC2253 specifies the unamiguous x509 subject format.
 * However, even when specifying this, different openssl implementations
 * wrap it differently, e.g "subject=X" vs "subject= X".
 */
const x509SubjectCNRegex = /[=,]\s*CN=([^,]*)(,.*)?$/;

export type SecureServerConfig = {
	key: Buffer;
	cert: Buffer;
	ca: Buffer;
	requestCert: boolean;
	rejectUnauthorized: boolean;
};

/*
 * This class is responsible for generating and deploying server and client
 * certificates to allow for secure communication between Flipper and apps.
 * It takes a Certificate Signing Request which was generated by the app,
 * using the app's public/private keypair.
 * With this CSR it uses the Flipper CA to sign a client certificate which it
 * deploys securely to the app.
 * It also deploys the Flipper CA cert to the app.
 * The app can trust a server if and only if it has a certificate signed by the
 * Flipper CA.
 */
export class CertificateProvider {
	private adbHelper: AdbHelper;
	private certificateSetup: Promise<void>;
	private logger: OutputChannelLogger;

	constructor(adbHelper: AdbHelper) {
		this.adbHelper = adbHelper;
		this.certificateSetup = this.ensureServerCertExists();
		this.logger = OutputChannelLogger.getChannel(
			NETWORK_INSPECTOR_LOG_CHANNEL_NAME,
		);
	}

	public loadSecureServerConfig(): Promise<SecureServerConfig> {
		return this.certificateSetup.then(() => {
			return {
				key: fs.readFileSync(serverKey),
				cert: fs.readFileSync(serverCert),
				ca: fs.readFileSync(caCert),
				requestCert: true,
				rejectUnauthorized: true, // can be false if necessary as we don't strictly need to verify the client
			};
		});
	}

	public async processCertificateSigningRequest(
		unsanitizedCsr: string,
		os: ClientOS,
		appDirectory: string,
		medium: CertificateExchangeMedium,
	): Promise<{ deviceId: string }> {
		const csr = this.santitizeString(unsanitizedCsr);
		if (csr === "") {
			return Promise.reject(
				new Error(`Received empty CSR from ${os} device`),
			);
		}
		this.ensureOpenSSLIsAvailable();
		const rootFolder = (await tmp.dir()).path;
		const certFolder = path.join(rootFolder, "FlipperCerts");
		return this.certificateSetup
			.then(() => this.getCACertificate())
			.then((caCert) =>
				this.deployOrStageFileForMobileApp(
					appDirectory,
					deviceCAcertFile,
					caCert,
					csr,
					os,
					medium,
					certFolder,
				),
			)
			.then(() => this.generateClientCertificate(csr))
			.then((clientCert) =>
				this.deployOrStageFileForMobileApp(
					appDirectory,
					deviceClientCertFile,
					clientCert,
					csr,
					os,
					medium,
					certFolder,
				),
			)
			.then(() => {
				return this.extractAppNameFromCSR(csr);
			})
			.then((appName) => {
				if (medium === "FS_ACCESS") {
					return this.getTargetDeviceId(
						os,
						appName,
						appDirectory,
						csr,
					);
				} else {
					return uuid();
				}
			})
			.then((deviceId) => {
				return {
					deviceId,
				};
			});
	}

	public extractAppNameFromCSR(csr: string): Promise<string> {
		return this.writeToTempFile(csr)
			.then((path) =>
				openssl("req", {
					in: path,
					noout: true,
					subject: true,
					nameopt: true,
					RFC2253: false,
				}).then((subject) => {
					return [path, subject];
				}),
			)
			.then(([path, subject]) => {
				return new Promise<string>((resolve, reject) => {
					fs.unlink(path, (err) => {
						if (err) {
							reject(err);
						} else {
							resolve(subject);
						}
					});
				});
			})
			.then((subject) => {
				const matches = subject.trim().match(x509SubjectCNRegex);
				if (!matches || matches.length < 2) {
					throw new Error(`Cannot extract CN from ${subject}`);
				}
				return matches[1];
			})
			.then((appName) => {
				if (!appName.match(allowedAppNameRegex)) {
					throw new Error(
						`Disallowed app name in CSR: ${appName}. Only alphanumeric characters and '.' allowed.`,
					);
				}
				return appName;
			});
	}

	public getTargetDeviceId(
		os: ClientOS,
		appName: string,
		appDirectory: string,
		csr: string,
	): Promise<string> {
		if (os === ClientOS.Android) {
			return this.getTargetAndroidDeviceId(appName, appDirectory, csr);
		} else if (os === ClientOS.iOS) {
			return this.getTargetiOSDeviceId(appName, appDirectory, csr);
		} else if (os === ClientOS.MacOS) {
			return Promise.resolve("");
		}
		return Promise.resolve("unknown");
	}

	private ensureOpenSSLIsAvailable(): void {
		if (!opensslInstalled()) {
			throw new Error(
				"It looks like you don't have OpenSSL installed globally. Please install it and add it to Path to continue.",
			);
		}
	}

	private getCACertificate(): Promise<string> {
		return new Promise((resolve, reject) => {
			fs.readFile(caCert, (err, data) => {
				if (err) {
					reject(err);
				} else {
					resolve(data.toString());
				}
			});
		});
	}

	private generateClientCertificate(csr: string): Promise<string> {
		return this.writeToTempFile(csr).then((path) => {
			return openssl("x509", {
				req: true,
				in: path,
				CA: caCert,
				CAkey: caKey,
				CAcreateserial: true,
				CAserial: serverSrl,
			});
		});
	}

	private getRelativePathInAppContainer(absolutePath: string) {
		const matches = /Application\/[^/]+\/(.*)/.exec(absolutePath);
		if (matches && matches.length === 2) {
			return matches[1];
		}
		throw new Error(`Path didn't match expected pattern: ${absolutePath}`);
	}

	private async deployOrStageFileForMobileApp(
		destination: string,
		filename: string,
		contents: string,
		csr: string,
		os: ClientOS,
		medium: CertificateExchangeMedium,
		certFolder: string,
	): Promise<void> {
		const appNamePromise = this.extractAppNameFromCSR(csr);

		if (medium === "WWW") {
			return fsUtils
				.writeFileToFolder(certFolder, filename, contents)
				.catch((e) => {
					throw new Error(
						`Failed to write ${filename} to temporary folder. Error: ${e}`,
					);
				});
		}

		if (os === ClientOS.Android) {
			const deviceIdPromise = appNamePromise.then((app) =>
				this.getTargetAndroidDeviceId(app, destination, csr),
			);
			return Promise.all([deviceIdPromise, appNamePromise]).then(
				([deviceId, appName]) => {
					if (process.platform === "win32") {
						return fsUtils
							.writeFileToFolder(certFolder, filename, contents)
							.then(() =>
								androidUtil.pushFile(
									this.adbHelper,
									deviceId,
									appName,
									destination + filename,
									path.join(certFolder, filename),
									this.logger,
								),
							);
					}
					return androidUtil.push(
						this.adbHelper,
						deviceId,
						appName,
						destination + filename,
						contents,
						this.logger,
					);
				},
			);
		}
		if (
			os === ClientOS.iOS ||
			os === ClientOS.Windows ||
			os === ClientOS.MacOS
		) {
			return fs.promises
				.writeFile(destination + filename, contents)
				.catch((err) => {
					if (os === ClientOS.iOS) {
						// Writing directly to FS failed. It's probably a physical device.
						const relativePathInsideApp =
							this.getRelativePathInAppContainer(destination);
						return appNamePromise
							.then((appName) => {
								return this.getTargetiOSDeviceId(
									appName,
									destination,
									csr,
								);
							})
							.then((udid) => {
								return appNamePromise.then((appName) =>
									this.pushFileToiOSDevice(
										udid,
										appName,
										relativePathInsideApp,
										filename,
										contents,
									),
								);
							});
					}
					throw new Error(
						`Invalid appDirectory recieved from ${os} device: ${destination}: ` +
							err.toString(),
					);
				});
		}
		return Promise.reject(new Error(`Unsupported device os: ${os}`));
	}

	private pushFileToiOSDevice(
		udid: string,
		bundleId: string,
		destination: string,
		filename: string,
		contents: string,
	): Promise<void> {
		return tmp.dir({ unsafeCleanup: true }).then((dir) => {
			const filePath = path.resolve(dir.path, filename);
			fs.promises
				.writeFile(filePath, contents)
				.then(() =>
					iosUtil.push(
						udid,
						filePath,
						bundleId,
						destination,
						this.logger,
					),
				);
		});
	}

	private getTargetAndroidDeviceId(
		appName: string,
		deviceCsrFilePath: string,
		csr: string,
	): Promise<string> {
		return this.adbHelper.getOnlineTargets().then((devices) => {
			if (devices.length === 0) {
				throw new Error("No Android devices found");
			}
			const deviceMatchList = devices.map((device) =>
				this.androidDeviceHasMatchingCSR(
					deviceCsrFilePath,
					device.id,
					appName,
					csr,
				)
					.then((result) => {
						return { id: device.id, ...result, error: null };
					})
					.catch((e) => {
						this.logger.error(
							`Unable to check for matching CSR in ${device.id}:${appName}`,
						);
						return {
							id: device.id,
							isMatch: false,
							foundCsr: null,
							error: e,
						};
					}),
			);
			return Promise.all(deviceMatchList).then((devices) => {
				const matchingIds = devices
					.filter((m) => m.isMatch)
					.map((m) => m.id);
				if (matchingIds.length === 0) {
					const erroredDevice = devices.find((d) => d.error);
					if (erroredDevice) {
						throw erroredDevice.error;
					}
					const foundCsrs = devices
						.filter((d) => d.foundCsr !== null)
						.map((d) =>
							d.foundCsr ? encodeURI(d.foundCsr) : "null",
						);
					this.logger.error(`Looking for CSR (url encoded):

            ${encodeURI(this.santitizeString(csr))}

            Found these:

            ${foundCsrs.join("\n\n")}`);
					throw new Error(
						`No matching device found for app: ${appName}`,
					);
				}
				if (matchingIds.length > 1) {
					this.logger.error(
						`More than one matching device found for CSR:\n${csr}`,
					);
				}
				return matchingIds[0];
			});
		});
	}

	private getTargetiOSDeviceId(
		appName: string,
		deviceCsrFilePath: string,
		csr: string,
	): Promise<string> {
		const matches = /\/Devices\/([^/]+)\//.exec(deviceCsrFilePath);
		if (matches && matches.length === 2) {
			// It's a simulator, the deviceId is in the filepath.
			return Promise.resolve(matches[1]);
		}
		return iosUtil.targets().then((targets) => {
			if (targets.length === 0) {
				throw new Error("No iOS devices found");
			}
			const deviceMatchList = targets.map((target) =>
				this.iOSDeviceHasMatchingCSR(
					deviceCsrFilePath,
					target.id,
					appName,
					csr,
				).then((isMatch) => {
					return { id: target.id, isMatch };
				}),
			);
			return Promise.all(deviceMatchList).then((devices) => {
				const matchingIds = devices
					.filter((m) => m.isMatch)
					.map((m) => m.id);
				if (matchingIds.length === 0) {
					throw new Error(
						`No matching device found for app: ${appName}`,
					);
				}
				return matchingIds[0];
			});
		});
	}

	private androidDeviceHasMatchingCSR(
		directory: string,
		deviceId: string,
		processName: string,
		csr: string,
	): Promise<{ isMatch: boolean; foundCsr: string }> {
		return androidUtil
			.pull(
				this.adbHelper,
				deviceId,
				processName,
				directory + csrFileName,
				this.logger,
			)
			.then((deviceCsr) => {
				// Santitize both of the string before comparation
				// The csr string extraction on client side return string in both way
				const [sanitizedDeviceCsr, sanitizedClientCsr] = [
					deviceCsr.toString(),
					csr,
				].map((s) => this.santitizeString(s));
				const isMatch = sanitizedDeviceCsr === sanitizedClientCsr;
				return { isMatch: isMatch, foundCsr: sanitizedDeviceCsr };
			});
	}

	private iOSDeviceHasMatchingCSR(
		directory: string,
		deviceId: string,
		bundleId: string,
		csr: string,
	): Promise<boolean> {
		const originalFile = this.getRelativePathInAppContainer(
			path.resolve(directory, csrFileName),
		);
		return tmp
			.dir({ unsafeCleanup: true })
			.then((dir) => {
				return iosUtil
					.pull(
						deviceId,
						originalFile,
						bundleId,
						path.join(dir.path, csrFileName),
						this.logger,
					)
					.then(() => dir);
			})
			.then((dir) => {
				return fs.promises
					.readdir(dir.path)
					.then((items) => {
						if (items.length > 1) {
							throw new Error("Conflict in temp dir");
						}
						if (items.length === 0) {
							throw new Error("Failed to pull CSR from device");
						}
						return items[0];
					})
					.then((fileName) => {
						const copiedFile = path.resolve(dir.path, fileName);
						return fs.promises
							.readFile(copiedFile)
							.then((data) =>
								this.santitizeString(data.toString()),
							);
					});
			})
			.then(
				(csrFromDevice) => csrFromDevice === this.santitizeString(csr),
			);
	}

	private santitizeString(csrString: string): string {
		return csrString.replace(/\r/g, "").trim();
	}

	private ensureCertificateAuthorityExists(): Promise<void> {
		if (!fs.existsSync(caKey)) {
			return this.generateCertificateAuthority();
		}
		return this.checkCertIsValid(caCert).catch(() =>
			this.generateCertificateAuthority(),
		);
	}

	private checkCertIsValid(filename: string): Promise<void> {
		if (!fs.existsSync(filename)) {
			return Promise.reject(new Error(`${filename} does not exist`));
		}
		// openssl checkend is a nice feature but it only checks for certificates
		// expiring in the future, not those that have already expired.
		// So we need a separate check for certificates that have already expired
		// but since this involves parsing date outputs from openssl, which is less
		// reliable, keeping both checks for safety.
		return openssl("x509", {
			checkend: minCertExpiryWindowSeconds,
			in: filename,
		})
			.then(() => undefined)
			.catch((e) => {
				this.logger.warning(
					localize(
						"NICertificateExpireSoon",
						"Certificate will expire soon: {0}",
						filename,
					),
				);
				throw e;
			})
			.then(() =>
				openssl("x509", {
					enddate: true,
					in: filename,
					noout: true,
				}),
			)
			.then((endDateOutput) => {
				const dateString = endDateOutput.trim().split("=")[1].trim();
				const expiryDate = Date.parse(dateString);
				if (Number.isNaN(expiryDate)) {
					this.logger.error(
						`Unable to parse certificate expiry date: ${endDateOutput}`,
					);
					throw new Error(
						"Cannot parse certificate expiry date. Assuming it has expired.",
					);
				}
				if (
					expiryDate <=
					Date.now() + minCertExpiryWindowSeconds * 1000
				) {
					throw new Error(
						"Certificate has expired or will expire soon.",
					);
				}
			});
	}

	private verifyServerCertWasIssuedByCA() {
		const options: {
			[key: string]: any;
		} = { CAfile: caCert };
		options[serverCert] = false;
		return openssl("verify", options).then((output) => {
			const verified = output.match(/[^:]+: OK/);
			if (!verified) {
				// This should never happen, but if it does, we need to notice so we can
				// generate a valid one, or no clients will trust our server.
				throw new Error(
					"Current server cert was not issued by current CA",
				);
			}
		});
	}

	private generateCertificateAuthority(): Promise<void> {
		if (!fs.existsSync(getFilePath(""))) {
			mkdirp.sync(getFilePath(""));
		}
		return openssl("genrsa", { out: caKey, "2048": false })
			.then(() =>
				openssl("req", {
					new: true,
					x509: true,
					subj: caSubject,
					key: caKey,
					out: caCert,
				}),
			)
			.then(() => undefined);
	}

	private async ensureServerCertExists(): Promise<void> {
		this.ensureOpenSSLIsAvailable();
		if (
			!(
				fs.existsSync(serverKey) &&
				fs.existsSync(serverCert) &&
				fs.existsSync(caCert)
			)
		) {
			return this.generateServerCertificate();
		}

		return this.checkCertIsValid(serverCert)
			.then(() => this.verifyServerCertWasIssuedByCA())
			.catch(() => this.generateServerCertificate());
	}

	private generateServerCertificate(): Promise<void> {
		return this.ensureCertificateAuthorityExists()
			.then(() => openssl("genrsa", { out: serverKey, "2048": false }))
			.then(() =>
				openssl("req", {
					new: true,
					key: serverKey,
					out: serverCsr,
					subj: serverSubject,
				}),
			)
			.then(() =>
				openssl("x509", {
					req: true,
					in: serverCsr,
					CA: caCert,
					CAkey: caKey,
					CAcreateserial: true,
					CAserial: serverSrl,
					out: serverCert,
				}),
			)
			.then(() => undefined);
	}

	private writeToTempFile(content: string): Promise<string> {
		return tmp
			.file()
			.then((path) =>
				fs.promises.writeFile(path.path, content).then(() => path.path),
			);
	}
}

/**
 * @preserve
 * End region: https://github.com/facebook/flipper/blob/v0.79.1/desktop/app/src/utils/CertificateProvider.tsx
 */

function getFilePath(fileName: string): string {
	return path.resolve(
		os.homedir(),
		".config",
		"vscode-react-native",
		"certs",
		fileName,
	);
}
