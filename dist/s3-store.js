"use strict";
/* Copyright (c) 2020-2023 Richard Rodger, MIT License */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const chokidar_1 = __importDefault(require("chokidar"));
const gubu_1 = require("gubu");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
// TODO: ent fields as dot paths
s3_store.defaults = {
    debug: false,
    prefix: (0, gubu_1.Empty)('seneca/db01/'),
    suffix: (0, gubu_1.Empty)('.json'),
    folder: (0, gubu_1.Any)(),
    s3: {},
    // keys are canon strings
    map: (0, gubu_1.Skip)({}),
    shared: (0, gubu_1.Skip)({}),
    // Use a local folder to simulate S3 for local dev and testing.
    local: {
        active: false,
        folder: '',
        suffixMode: 'none', // TODO: FIX: Default('none', Exact('none', 'genid')),
        onObjectCreated: '',
    },
    // keys are canon strings
    ent: (0, gubu_1.Default)({}, (0, gubu_1.Child)({
        // Save a sub array as JSONL. NOTE: Other fields are LOST!
        jsonl: (0, gubu_1.Skip)(String),
        // Save a sub field as binary. NOTE: Other fields are LOST!
        bin: (0, gubu_1.Skip)(String),
    })),
};
const PLUGIN = '@seneca/s3-store';
async function s3_store(options) {
    const seneca = this;
    const init = seneca.export('entity/init');
    let generate_id = options.generate_id || seneca.export('entity/generate_id');
    let aws_s3 = null;
    let s3_shared_options = {
        Bucket: '!not-a-bucket!',
        ...options.shared,
    };
    let local_folder = '';
    seneca.init(function (reply) {
        if (options.local.active) {
            let folder = options.local.folder;
            local_folder =
                'genid' == options.local.suffixMode
                    ? folder + '-' + seneca.util.Nid()
                    : folder;
            // Watch for local file changes and trigger upload logic.
            const watcher = chokidar_1.default.watch(path_1.default.resolve(options.local.folder), {
                ignoreInitial: true,
            });
            watcher.on('add', (path) => {
                const keyPath = path
                    .split(path_1.default.sep)
                    .slice(path.split(path_1.default.sep).indexOf('folder01'))
                    .join(path_1.default.sep);
                // console.log(`WATCH path: ${keyPath}`);
                const event = {
                    Records: [
                        {
                            s3: {
                                object: {
                                    key: keyPath,
                                },
                            },
                        },
                    ],
                };
                if (options.local.onObjectCreated) {
                    seneca.post(options.local.onObjectCreated, { event });
                }
            });
            // .on('error', error => console.log(`WATCH error: ${error}`))
            // .on('ready', () => console.log('WATCH initial scan complete. ready for changes'));
        }
        else {
            const s3_opts = {
                s3ForcePathStyle: true,
                ...options.s3,
            };
            aws_s3 = new client_s3_1.S3Client(s3_opts);
        }
        reply();
    });
    let store = {
        name: 's3-store',
        save: function (msg, reply) {
            // console.log('MSG', msg)
            let canon = msg.ent.entity$;
            let id = '' + (msg.ent.id || msg.ent.id$ || generate_id(msg.ent));
            let d = msg.ent.data$();
            d.id = id;
            let entSpec = options.ent[canon];
            let jsonl = (entSpec === null || entSpec === void 0 ? void 0 : entSpec.jsonl) || msg.jsonl$ || msg.q.jsonl$;
            let bin = (entSpec === null || entSpec === void 0 ? void 0 : entSpec.bin) || msg.bin$ || msg.q.bin$;
            let s3id = make_s3id(id, msg.ent, options, bin);
            let Body = undefined;
            if (entSpec || jsonl || bin) {
                // JSONL files
                if ('string' === typeof jsonl && '' !== jsonl) {
                    let arr = msg.ent[jsonl];
                    if (!Array.isArray(arr)) {
                        throw new Error('s3-store: option ent.jsonl array field not found: ' + jsonl);
                    }
                    let content = arr.map((n) => JSON.stringify(n)).join('\n') + '\n';
                    Body = Buffer.from(content);
                }
                // Binary files
                else if ('string' === typeof bin && '' !== bin) {
                    let data = msg.ent[bin];
                    if (null == data) {
                        throw new Error('s3-store: option ent.bin data field not found: ' + bin);
                    }
                    Body = Buffer.from(data);
                }
            }
            if (null == Body) {
                let dj = JSON.stringify(d);
                Body = Buffer.from(dj);
            }
            // console.log('BODY', Body, entSpec?.bin ? '' : '<' + Body.toString() + '>')
            // console.log('options:: ', options, seneca.util.Nid() )
            let ento = msg.ent.make$().data$(d);
            // Local file
            if (options.local.active) {
                let full = path_1.default.join(local_folder, s3id || id);
                let path = path_1.default.dirname(full);
                if (options.debug) {
                    console.log(PLUGIN, 'save', path, Body.length);
                }
                promises_1.default.mkdir(path, { recursive: true })
                    .then(() => {
                    promises_1.default.writeFile(full, Body)
                        .then((_res) => {
                        reply(null, ento);
                    })
                        .catch((err) => {
                        reply(err);
                    });
                })
                    .catch((err) => {
                    reply(err);
                });
            }
            // AWS S3
            else {
                const s3cmd = new client_s3_1.PutObjectCommand({
                    ...s3_shared_options,
                    Key: s3id,
                    Body,
                });
                aws_s3
                    .send(s3cmd)
                    .then((_res) => {
                    reply(null, ento);
                })
                    .catch((err) => {
                    reply(err);
                });
            }
        },
        load: function (msg, reply) {
            let canon = msg.ent.entity$;
            let qent = msg.qent;
            let id = '' + msg.q.id;
            let entSpec = options.ent[canon];
            let output = 'ent';
            let jsonl = (entSpec === null || entSpec === void 0 ? void 0 : entSpec.jsonl) || msg.jsonl$ || msg.q.jsonl$;
            let bin = (entSpec === null || entSpec === void 0 ? void 0 : entSpec.bin) || msg.bin$ || msg.q.bin$;
            let s3id = make_s3id(id, msg.ent, options, bin);
            output = jsonl && '' != jsonl ? 'jsonl' : bin && '' != bin ? 'bin' : 'ent';
            function replyEnt(body) {
                let entdata = {};
                // console.log('DES', output, body)
                if ('bin' !== output) {
                    body = body.toString('utf-8');
                }
                if ('jsonl' === output) {
                    entdata[jsonl] = body
                        .split('\n')
                        .filter((n) => '' !== n)
                        .map((n) => JSON.parse(n));
                }
                else if ('bin' === output) {
                    entdata[bin] = body;
                }
                else {
                    entdata = JSON.parse(body);
                }
                entdata.id = id;
                let ento = qent.make$().data$(entdata);
                reply(null, ento);
            }
            // Local file
            if (options.local.active) {
                let full = path_1.default.join(local_folder, s3id || id);
                // console.log('FULL', full)
                if (options.debug) {
                    console.log(PLUGIN, 'load', full);
                }
                promises_1.default.readFile(full)
                    .then((body) => {
                    replyEnt(body);
                })
                    .catch((err) => {
                    if ('ENOENT' == err.code) {
                        return reply();
                    }
                    reply(err);
                });
            }
            // AWS S3
            else {
                const s3cmd = new client_s3_1.GetObjectCommand({
                    ...s3_shared_options,
                    Key: s3id,
                });
                aws_s3
                    .send(s3cmd)
                    .then((res) => {
                    // console.log(res)
                    destream(output, res.Body)
                        .then((body) => {
                        replyEnt(body);
                    })
                        .catch((err) => reply(err));
                })
                    .catch((err) => {
                    if ('NoSuchKey' === err.Code) {
                        return reply();
                    }
                    reply(err);
                });
            }
        },
        // NOTE: S3 folder listing not supported yet.
        list: function (_msg, reply) {
            reply([]);
        },
        remove: function (msg, reply) {
            let canon = (msg.ent || msg.qent).entity$;
            let id = '' + msg.q.id;
            let entSpec = options.ent[canon];
            let bin = (entSpec === null || entSpec === void 0 ? void 0 : entSpec.bin) || msg.bin$ || msg.q.bin$;
            let s3id = make_s3id(id, msg.ent, options, bin);
            // Local file
            if (options.local.active) {
                let full = path_1.default.join(local_folder, s3id || id);
                promises_1.default.unlink(full)
                    .then((_res) => {
                    reply();
                })
                    .catch((err) => {
                    if ('ENOENT' == err.code) {
                        return reply();
                    }
                    reply(err);
                });
            }
            else {
                const s3cmd = new client_s3_1.DeleteObjectCommand({
                    ...s3_shared_options,
                    Key: s3id,
                });
                aws_s3
                    .send(s3cmd)
                    .then((_res) => {
                    reply();
                })
                    .catch((err) => {
                    if ('NoSuchKey' === err.Code) {
                        return reply();
                    }
                    reply(err);
                });
            }
        },
        close: function (_msg, reply) {
            reply();
        },
        native: function (_msg, reply) {
            reply({ client: aws_s3, local: { ...options.local } });
        },
    };
    let meta = init(seneca, options, store);
    seneca.message('cloud:aws,service:store,get:url,kind:upload', {
        bucket: String,
        filepath: String,
        expire: Number,
    }, get_upload_url);
    seneca.message('cloud:aws,service:store,get:url,kind:download', {
        bucket: String,
        filepath: String,
        expire: Number,
    }, get_download_url);
    async function get_upload_url(msg) {
        const bucket = msg.bucket;
        const filepath = msg.filepath;
        const expire = msg.expire;
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: filepath,
        });
        const url = await (0, s3_request_presigner_1.getSignedUrl)(aws_s3, command, {
            expiresIn: expire,
        });
        return {
            url,
            bucket,
            filepath,
            expire,
        };
    }
    async function get_download_url(msg) {
        const bucket = msg.bucket;
        const filepath = msg.filepath;
        const expire = msg.expire;
        const command = new client_s3_1.GetObjectCommand({
            Bucket: bucket,
            Key: filepath,
        });
        const url = await (0, s3_request_presigner_1.getSignedUrl)(aws_s3, command, {
            expiresIn: expire,
        });
        return {
            url,
            bucket,
            filepath,
            expire,
        };
    }
    return {
        name: store.name,
        tag: meta.tag,
        exportmap: {
            native: aws_s3,
        },
    };
}
function make_s3id(id, ent, options, bin) {
    let s3id = null == id
        ? null
        : (null == options.folder
            ? options.prefix + ent.entity$
            : options.folder) +
            ('' == options.folder ? '' : '/') +
            id +
            (bin ? '' : options.suffix);
    // console.log('make_s3id', s3id, id, ent, options)
    return s3id;
}
async function destream(output, stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => {
            let buffer = Buffer.concat(chunks);
            if ('bin' === output) {
                resolve(buffer);
            }
            else {
                resolve(buffer.toString('utf-8'));
            }
        });
    });
}
Object.defineProperty(s3_store, 'name', { value: 's3-store' });
module.exports = s3_store;
//# sourceMappingURL=s3-store.js.map