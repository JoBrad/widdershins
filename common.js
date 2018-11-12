'use strict';

const jptr = require('reftools/lib/jptr.js').jptr;
const sampler = require('openapi-sampler');
const safejson = require('safe-json-stringify');
const recurse = require('reftools/lib/recurse.js').recurse;
const visit = require('reftools/lib/visit.js').visit;
const clone = require('reftools/lib/clone.js').clone;
const circularClone = require('reftools/lib/clone.js').circularClone;
const walkSchema = require('oas-schema-walker').walkSchema;
const wsGetState = require('oas-schema-walker').getDefaultState;
const httpsnippetGenerator = require('./httpsnippetGenerator');

/* originally from https://github.com/for-GET/know-your-http-well/blob/master/json/status-codes.json */
/* "Unlicensed", public domain */
const statusCodes = require('./statusCodes.json');

// @TODO: Make a global options-parsing function!

const contentTypes = {
    xml: ['^(application|text|image){1}\\/(.*\\+){0,1}xml(;){0,1}(\\s){0,}(charset=.*){0,}$'],
    json: ['^(application|text){1}\\/(.*\\+){0,1}json(;){0,1}(\\s){0,}(charset=.*){0,}$'],
    yaml: ['application/x-yaml', 'text/x-yaml'],
    form: ['multipart/form-data', 'application/x-www-form-urlencoded', 'application/octet-stream']
};

function nop(obj) {
    return obj;
}

function doContentType(ctTypes, ctClass) {
    for (let type of ctTypes) {
        for (let target of contentTypes[ctClass] || []) {
            if (type.match(target)) return true;
        }
    }
    return false;
}

/**
 * Returns a normalized language preference,
 * or false, if it is invalid or missing required detail.
 *
 * @param {string} language
 * @param {array} language_tabs
 * @param {boolean} mutate
 * @returns {string|boolean}
 */
function languageCheck(language, language_tabs, mutate) {
    var lcLang = language.toLowerCase();
    if (lcLang === 'c#') lcLang = 'csharp';
    if (lcLang === 'c++') lcLang = 'cpp';
    for (var l in language_tabs) {
        var target = language_tabs[l];
        if (typeof target === 'object') {
            if (Object.keys(target)[0] === lcLang) {
                return lcLang;
            }
        } else {
            if (target === lcLang) return lcLang;
        }
    }
    if (mutate) {
        var newLang = {};
        newLang[lcLang] = language;
        language_tabs.push(newLang);
        return lcLang;
    }
    return false;
}

/**
 * Returns code samples for the operation. Code samples provided
 * in the "x-code-samples" property will override generated samples.
 *
 * @param {object} data
 * @returns {string}
 */
function getCodeSamples(data) {
    let returnSamples = '';
    const op = data.operation || data.message;
    if (op && op["x-code-samples"]) {
        for (var c in op["x-code-samples"]) {
            let sample = op["x-code-samples"][c];
            const lang = languageCheck(sample.lang, data.header.language_tabs, true);
            returnSamples += generateCodeSnippet(lang, sample.source);
        }
    } else {
        const samplesGenerator = data.options.httpsnippet ?
            httpsnippetGenerator.generate :
            fileTemplateGenerator;

        const codeSamples = data.header.language_tabs
            .map(tab => {
                const lang = typeof tab === 'object' ?
                    Object.keys(tab)[0] :
                    tab;

                const lowerCaseLanguage = languageCheck(lang, data.header.language_tabs, false);
                const target = getLanguageTarget(lowerCaseLanguage);
                const client = getLanguageClient(lang, data.options.language_clients);

                const sample = (target && samplesGenerator(target, client, data)) || '';
                return (sample && generateCodeSnippet(lowerCaseLanguage, sample)) || '';
            });

        returnSamples += codeSamples.join('');
    }
    return returnSamples;
}

/**
 * Check if language custom target is used
 * i.e., javascript--nodejs -> nodejs
 *
 * @param {string} lang
 * @returns {string}
 */
function getLanguageTarget(lang) {
    return (lang && lang.split('--')[1]) || lang;
}

/**
 * Returns the client for the specified language
 *
 * @param {string} lang
 * @param {object} clients
 * @returns {string}
 */
function getLanguageClient(lang, clients) {
    if (!(lang && clients && clients.length)) return '';
    const client = clients.find(function(e, i, a) {
        return Object.keys(e)[0] === lang;
    });
    if (client) return Object.values(client)[0];
    return '';
}

/**
 * Returns a code template for the provided code target
 *
 * @param {string} target
 * @param {object} client
 * @param {object} data
 * @returns {string}
 */
function fileTemplateGenerator(target, client, data) {
    const templateName = getCodeSampleTemplateName(target);
    const templateFunc = data.templates[templateName];
    return (templateFunc && templateFunc(data)) || '';
}

/**
 * Returns the name of the code template for the provided code name
 *
 * @param {string} target
 * @returns {string}
 */
function getCodeSampleTemplateName(target) {
    return `code_${target}`;
}

/**
 * Returns the provided lang surrounded by Markdown syntax for code
 *
 * @param {string} lang
 * @param {string} code
 * @returns {string}
 */
function generateCodeSnippet(lang, code) {
    const snippetSeparator = '```';
    return `${snippetSeparator}${lang}\n${code}\n${snippetSeparator}\n\n`;
}

function gfmLink(text) {
    text = text.trim().toLowerCase();
    text = text.split("'").join('');
    text = text.split('"').join('');
    text = text.split('.').join('');
    text = text.split('`').join('');
    text = text.split(':').join('');
    text = text.split('/').join('');
    text = text.split('&lt;').join('');
    text = text.split('&gt;').join('');
    text = text.split('<').join('');
    text = text.split('>').join('');
    text = text.split(' ').join('-');
    return text;
}

/**
 * Returns the type of object for this schema. If it is not specified,
 * then it is inferred based on the schema properties.
 *
 * @param {object} schema
 * @returns {string}
 */
function inferType(schema) {

    function has(properties) {
        for (let property of properties) {
            if (typeof schema[property] !== 'undefined') return true;
        }
        return false;
    }

    if (schema.type) return schema.type;
    let possibleTypes = [];
    if (has(['properties', 'additionalProperties', 'patternProperties', 'minProperties', 'maxProperties', 'required', 'dependencies'])) {
        possibleTypes.push('object');
    }
    if (has(['items', 'additionalItems', 'maxItems', 'minItems', 'uniqueItems'])) {
        possibleTypes.push('array');
    }
    if (has(['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'])) {
        possibleTypes.push('number');
    }
    if (has(['maxLength', 'minLength', 'pattern'])) {
        possibleTypes.push('number');
    }
    if (schema.enum) {
        for (let value of schema.enum) {
            possibleTypes.push(typeof value); // doesn't matter about dupes
        }
    }

    if (possibleTypes.length === 1) return possibleTypes[0];
    return 'any';
}

function strim(obj, maxDepth) {
    if (maxDepth <= 0) return obj;
    recurse(obj, {}, function(obj, key, state) {
        if (state.depth >= maxDepth) {
            if (Array.isArray(state.parent[state.pkey])) {
                state.parent[state.pkey] = [];
            } else if (typeof state.parent[state.pkey] === 'object') {
                state.parent[state.pkey] = {};
            }
        }
    });
    return obj;
}

function schemaToArray(schema, offset, options, data) {
    let iDepth = 0;
    let oDepth = 0;
    let blockDepth = 0;
    let skipDepth = -1;
    let container = [];
    let block = { title: '', rows: [] };
    if (schema) {
        if (schema.title) block.title = schema.title;
        if (!block.title && schema.description)
            block.title = schema.description;
        block.description = schema.description;
        if (schema.externalDocs)
            block.externalDocs = schema.externalDocs;
    }
    container.push(block);
    let wsState = wsGetState();
    wsState.combine = true;
    wsState.allowRefSiblings = true;
    walkSchema(schema, {}, wsState, function(schema, parent, state) {

        let isBlock = false;
        if (state.property && (state.property.startsWith('allOf') || state.property.startsWith('anyOf') || state.property.startsWith('oneOf') || (state.property === 'not'))) {
            isBlock = true;
            let components = (state.property + '/0').split('/');
            if (components[1] !== '0') {
                if (components[0] === 'allOf') components[0] = 'and';
                if (components[0] === 'anyOf') components[0] = 'or';
                if (components[0] === 'oneOf') components[0] = 'xor';
            }
            block = { title: components[0], rows: [] };
            let dschema = schema;
            let prefix = '';
            if (schema.$ref) {
                dschema = jptr(data.api, schema.$ref);
                prefix = schema.$ref.replace('#/components/schemas/', '') + '.';
            }
            if (dschema.discriminator) {
                block.title += ' - discriminator: ' + prefix + dschema.discriminator.propertyName;
            }
            container.push(block);
            blockDepth = state.depth;
        } else {
            if (blockDepth && state.depth < blockDepth) {
                block = { title: data.translations.continued, rows: [] };
                container.push(block);
                blockDepth = 0;
            }
        }

        let entry = {};
        entry.schema = schema;
        entry.in = 'body';
        if (state.property && state.property.indexOf('/')) {
            if (isBlock) entry.name = '*' + data.translations.anonymous + '*'
            else entry.name = state.property.split('/')[1];
        } else if (!state.top) console.warn(state.property);
        if (!entry.name && schema.title) entry.name = schema.title;

        if (schema.type === 'array' && schema.items && schema.items["x-widdershins-oldRef"] && !entry.name) {
            state.top = false; // force it in
        } else if (schema.type === 'array' && schema.items && schema.items.$ref && !entry.name) {
            state.top = false; // force it in, for un-dereferenced schemas
        } else if (!entry.name && state.top && schema.type && schema.type !== 'object' && schema.type !== 'array') {
            state.top = false;
        }

        if (!state.top && !entry.name && state.property === 'additionalProperties') {
            entry.name = '**additionalProperties**';
        }
        if (!state.top && !entry.name && state.property === 'additionalItems') {
            entry.name = '**additionalItems**';
        }
        if (!state.top && !entry.name && state.property && state.property.startsWith('patternProperties')) {
            entry.name = '*' + entry.name + '*';
        }
        if (!state.top && !entry.name && !parent.items) {
            entry.name = '*' + data.translations.anonymous + '*';
        }

        // we should be done futzing with entry.name now

        if (entry.name) {
            if (state.depth > iDepth) {
                oDepth++;
            }
            if (state.depth < iDepth) {
                oDepth--;
                if (oDepth < 0) oDepth = 0;
            }
            iDepth = state.depth;
            //console.warn('state %s, idepth %s, odepth now %s, offset %s',state.depth,iDepth,oDepth,offset);
        }

        entry.depth = Math.max(oDepth + offset, 0);
        //entry.depth = Math.max(oDepth-1,0)/2;
        //if (entry.depth<1) entry.depth = 0;

        entry.description = schema.description;
        entry.type = schema.type;
        entry.format = schema.format;

        entry.safeType = entry.type;

        if (schema["x-widdershins-oldRef"]) {
            entry.$ref = schema["x-widdershins-oldRef"].replace('#/components/schemas/', '');
            entry.safeType = '[' + entry.$ref + '](#schema' + entry.$ref.toLowerCase() + ')';
            if (data.options.shallowSchemas) skipDepth = entry.depth;
            if (!entry.description) {
                let target = jptr(data.api, schema["x-widdershins-oldRef"]);
                if (target.description) entry.description = target.description;
            }
        }
        if (schema.$ref) { // repeat for un-dereferenced schemas
            entry.$ref = schema.$ref.replace('#/components/schemas/', '');
            entry.type = '$ref';
            entry.safeType = '[' + entry.$ref + '](#schema' + entry.$ref.toLowerCase() + ')';
            if (data.options.shallowSchemas) skipDepth = entry.depth;
            if (!entry.description) {
                let target = jptr(data.api, schema.$ref);
                if (target.description) entry.description = target.description;
            }
        }

        if (entry.format) entry.safeType = entry.safeType + '(' + entry.format + ')';
        if ((entry.type === 'array') && schema.items) {
            let itemsType = schema.items.type || 'any';
            if (schema.items["x-widdershins-oldRef"]) {
                let $ref = schema.items["x-widdershins-oldRef"].replace('#/components/schemas/', '');
                itemsType = '[' + $ref + '](#schema' + $ref.toLowerCase() + ')';
                if (!entry.description) {
                    let target = jptr(data.api, schema.items["x-widdershins-oldRef"]);
                    if (target.description) entry.description = '[' + target.description + ']';
                }
            }
            if (schema.items.$ref) { // repeat for un-dereferenced schemas
                let $ref = schema.items.$ref.replace('#/components/schemas/', '');
                itemsType = '[' + $ref + '](#schema' + $ref.toLowerCase() + ')';
                if (!entry.description) {
                    let target = jptr(data.api, schema.items.$ref);
                    if (target.description) entry.description = '[' + target.description + ']';
                }
            }
            if (schema.items.anyOf) itemsType = 'anyOf';
            if (schema.items.allOf) itemsType = 'allOf';
            if (schema.items.oneOf) itemsType = 'oneOf';
            if (schema.items.not) itemsType = 'not';
            entry.safeType = '[' + itemsType + ']';
        }

        if (options.trim && typeof entry.description === 'string') {
            entry.description = entry.description.trim();
        }
        if (options.join && typeof entry.description === 'string') {
            entry.description = entry.description.split('\r').join('').split('\n').join(' ');
        }
        if (options.truncate && typeof entry.description === 'string') {
            entry.description = entry.description.split('\r').join('').split('\n')[0];
        }
        if (entry.description === 'undefined') { // yes, the string
            entry.description = '';
        }

        if (schema.nullable === true) {
            entry.safeType += '\\|null';
        }

        if (schema.readOnly) entry.restrictions = data.translations.readOnly;
        if (schema.writeOnly) entry.restrictions = data.translations.writeOnly;

        entry.required = (parent.required && Array.isArray(parent.required) && parent.required.indexOf(entry.name) >= 0);
        if (typeof entry.required === 'undefined') entry.required = false;

        if (typeof entry.type === 'undefined') {
            entry.type = inferType(schema);
            entry.safeType = entry.type;
        }

        if (typeof entry.name === 'string' && entry.name.startsWith('x-widdershins-')) {
            entry.name = ''; // reset
        }
        if ((skipDepth >= 0) && (entry.depth >= skipDepth)) entry.name = ''; // reset
        if (entry.depth < skipDepth) skipDepth = -1;
        entry.displayName = (data.translations.indent.repeat(entry.depth) + ' ' + entry.name).trim();

        if ((!state.top || entry.type !== 'object') && (entry.name)) {
            block.rows.push(entry);
        }
    });
    return container;
}

/**
 * Removes any custom keys from the provided object
 *
 * @param {object} obj
 * @returns {object}
 */
function clean(obj) {
    if (typeof obj === 'undefined') return {};
    visit(obj, {}, {
        filter: function(obj, key, state) {
            if (!key.startsWith('x-widdershins')) return obj[key];
        }
    });
    return obj;
}

/**
 * Returns a sample request or response from the provided object.
 * If an example is not created, uses openapi-sampler to generate one.
 *
 * @param {object} orig
 * @param {object} options
 * @param {object} samplerOptions
 * @param {object} api
 * @returns {string}
 */
function getSampleInner(orig, options, samplerOptions, api) {
    if (!options.samplerErrors) options.samplerErrors = new Map();
    let obj = circularClone(orig);
    let defs = api; //Object.assign({},api,orig);
    if (options.sample && obj) {
        try {
            var sample = sampler.sample(obj, samplerOptions, defs); // was api
            if (sample && typeof sample.$ref !== 'undefined') {
                //console.warn(util.inspect(orig));
                obj = JSON.parse(safejson(orig));
                sample = sampler.sample(obj, samplerOptions, defs);
            }
            if (typeof sample !== 'undefined') {
                if (sample !== null && Object.keys(sample).length) return sample
                else {
                    return sampler.sample({ type: 'object', properties: { anonymous: obj } }, samplerOptions, defs).anonymous;
                }
            }
        } catch (ex) {
            if (options.samplerErrors.has(ex.message)) {
                process.stderr.write('.');
            } else {
                console.error('# sampler ' + ex.message);
                options.samplerErrors.set(ex.message, true);
            }
            if (options.verbose) {
                console.error(ex);
            }
            obj = JSON.parse(safejson(orig));
            try {
                sample = sampler.sample(obj, samplerOptions, defs);
                if (typeof sample !== 'undefined') return sample;
            } catch (ex) {
                if (options.samplerErrors.has(ex.message)) {
                    process.stderr.write('.');
                } else {
                    console.warn('# sampler 2nd error ' + ex.message);
                    options.samplerErrors.set(ex.message, true);
                }
            }
        }
    }
    return obj;
}

/**
 * Returns a example request or response from the provided object
 *
 * @param {object} orig
 * @param {object} options
 * @param {object} samplerOptions
 * @param {object} api
 * @returns {object}
 */
function getSample(orig, options, samplerOptions, api) {
    if (orig && orig.example) return orig.example;
    let result = getSampleInner(orig, options, samplerOptions, api);
    result = clean(result);
    result = strim(result, options.maxDepth);
    return result;
}

/**
 * Removes all occurences of 3 or more consecutive blank lines
 *
 * @param {string} content
 * @returns {string}
 */
function removeDupeBlankLines(content) {
    return content.replace(/[\r\n]{3,}/g, '\n\n');
}

/**
 * If obj is an object or array, it is stringified. Otherwise the value is returned.
 *
 * @param {any} obj
 * @returns {number|string|boolean}
 */
function toPrimitive(obj) {
    if (typeof obj === 'object') { // including arrays
        return JSON.stringify(obj);
    }
    return obj;
}

function slugify(text) {
    return text.toString().toLowerCase().trim()
        .replace(/&/g, '-and-') // Replace & with 'and'
        .replace(/[\s\W-]+/g, '-') // Replace spaces, non-word characters and dashes with a single dash (-)
}

module.exports = {
    statusCodes: statusCodes,
    doContentType: doContentType,
    languageCheck: languageCheck,
    getCodeSamples: getCodeSamples,
    inferType: inferType,
    clone: clone,
    clean: clean,
    strim: strim,
    slugify: slugify,
    getSample: getSample,
    gfmLink: gfmLink,
    schemaToArray: schemaToArray,
    removeDupeBlankLines: removeDupeBlankLines,
    toPrimitive: toPrimitive
};
