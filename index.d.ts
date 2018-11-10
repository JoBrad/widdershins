
declare interface MarkdownOptions {
    codeSamples?:boolean;
    customApiKeyValue?:string;
    discovery?:boolean;
    expandBody?:boolean;
    experimental?:boolean;
    headings?:number;
    httpsnippet?:boolean;
    includes?:string[];
    lang?:boolean;
    language_tabs?:object[];
    maxDepth?:number;
    omitBody?:boolean;
    raw?:boolean;
    resolve?:boolean;
    search?:boolean;
    sample?:boolean;
    shallowSchemas?:boolean;
    theme?:string;
    tocSummary?:boolean;
    verbose?:boolean;
    yaml?:boolean;
    user_templates?:string;
    outfile?:string;
}

export function convert(api: object, options: MarkdownOptions, callback: Function): void;
