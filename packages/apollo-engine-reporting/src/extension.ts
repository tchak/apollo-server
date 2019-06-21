import { Request, WithRequired } from 'apollo-server-env';

import {
  GraphQLResolveInfo,
  DocumentNode,
  ExecutionArgs,
  GraphQLError,
} from 'graphql';
import { GraphQLExtension, EndHandler } from 'graphql-extensions';
import { Trace, google } from 'apollo-engine-reporting-protobuf';

import {
  EngineReportingOptions,
  GenerateClientInfo,
  AddTraceArgs,
} from './agent';
import { EngineReportingTreeBuilder } from './treeBuilder';
import { GraphQLRequestContext } from 'apollo-server-core/dist/requestPipelineAPI';

const clientNameHeaderKey = 'apollographql-client-name';
const clientReferenceIdHeaderKey = 'apollographql-client-reference-id';
const clientVersionHeaderKey = 'apollographql-client-version';

// (DEPRECATE)
// This special type is used internally to this module to implement the
// `maskErrorDetails` (https://github.com/apollographql/apollo-server/pull/1615)
// functionality in the exact form it was originally implemented — which didn't
// have the result matching the interface provided by `GraphQLError` but instead
// just had a `message` property set to `<masked>`.  Since `maskErrorDetails`
// is now slated for deprecation (with its behavior superceded by the more
// robust `rewriteError` functionality, this GraphQLErrorOrMaskedErrorObject`
// should be removed when that deprecation is completed in a major release.
type GraphQLErrorOrMaskedErrorObject =
  | GraphQLError
  | (Partial<GraphQLError> & Pick<GraphQLError, 'message'>);

// EngineReportingExtension is the per-request GraphQLExtension which creates a
// trace (in protobuf Trace format) for a single request. When the request is
// done, it passes the Trace back to its associated EngineReportingAgent via the
// addTrace callback in its constructor. This class isn't for direct use; its
// constructor is a private API for communicating with EngineReportingAgent.
// Its public methods all implement the GraphQLExtension interface.
export class EngineReportingExtension<TContext = any>
  implements GraphQLExtension<TContext> {
  public trace = new Trace();
  private treeBuilder = new EngineReportingTreeBuilder();
  private explicitOperationName?: string | null;
  private queryString?: string;
  private documentAST?: DocumentNode;
  private options: EngineReportingOptions<TContext>;
  private addTrace: (args: AddTraceArgs) => Promise<void>;
  private generateClientInfo: GenerateClientInfo<TContext>;

  public constructor(
    options: EngineReportingOptions<TContext>,
    addTrace: (args: AddTraceArgs) => Promise<void>,
  ) {
    this.options = {
      ...options,
    };
    this.addTrace = addTrace;
    this.generateClientInfo =
      options.generateClientInfo || defaultGenerateClientInfo;
  }

  public requestDidStart(o: {
    request: Request;
    queryString?: string;
    parsedQuery?: DocumentNode;
    variables?: Record<string, any>;
    context: TContext;
    extensions?: Record<string, any>;
    requestContext: WithRequired<
      GraphQLRequestContext<TContext>,
      'metrics' | 'queryHash'
    >;
  }): EndHandler {
    this.trace.startTime = dateToTimestamp(new Date());
    this.treeBuilder.startTiming();

    // Generally, we'll get queryString here and not parsedQuery; we only get
    // parsedQuery if you're using an OperationStore. In normal cases we'll get
    // our documentAST in the execution callback after it is parsed.
    const queryHash = o.requestContext.queryHash;
    this.queryString = o.queryString;
    this.documentAST = o.parsedQuery;

    this.trace.http = new Trace.HTTP({
      method:
        Trace.HTTP.Method[o.request.method as keyof typeof Trace.HTTP.Method] ||
        Trace.HTTP.Method.UNKNOWN,
      // Host and path are not used anywhere on the backend, so let's not bother
      // trying to parse request.url to get them, which is a potential
      // source of bugs because integrations have different behavior here.
      // On Node's HTTP module, request.url only includes the path
      // (see https://nodejs.org/api/http.html#http_message_url)
      // The same is true on Lambda (where we pass event.path)
      // But on environments like Cloudflare we do get a complete URL.
      host: null,
      path: null,
    });
    if (this.options.privateHeaders !== true) {
      for (const [key, value] of o.request.headers) {
        if (
          this.options.privateHeaders &&
          Array.isArray(this.options.privateHeaders) &&
          // We assume that most users only have a few private headers, or will
          // just set privateHeaders to true; we can change this linear-time
          // operation if it causes real performance issues.
          this.options.privateHeaders.some(privateHeader => {
            // Headers are case-insensitive, and should be compared as such.
            return privateHeader.toLowerCase() === key.toLowerCase();
          })
        ) {
          continue;
        }

        switch (key) {
          case 'authorization':
          case 'cookie':
          case 'set-cookie':
            break;
          default:
            this.trace.http!.requestHeaders![key] = new Trace.HTTP.Values({
              value: [value],
            });
        }
      }

      if (o.requestContext.metrics.persistedQueryHit) {
        this.trace.persistedQueryHit = true;
      }
      if (o.requestContext.metrics.persistedQueryRegister) {
        this.trace.persistedQueryRegister = true;
      }
    }

    if (this.options.privateVariables !== true && o.variables) {
      // Note: we explicitly do *not* include the details.rawQuery field. The
      // Engine web app currently does nothing with this other than store it in
      // the database and offer it up via its GraphQL API, and sending it means
      // that using calculateSignature to hide sensitive data in the query
      // string is ineffective.
      this.trace.details = new Trace.Details();
      Object.keys(o.variables).forEach(name => {
        if (
          this.options.privateVariables &&
          Array.isArray(this.options.privateVariables) &&
          // We assume that most users will have only a few private variables,
          // or will just set privateVariables to true; we can change this
          // linear-time operation if it causes real performance issues.
          this.options.privateVariables.includes(name)
        ) {
          // Special case for private variables. Note that this is a different
          // representation from a variable containing the empty string, as that
          // will be sent as '""'.
          this.trace.details!.variablesJson![name] = '';
        } else {
          try {
            this.trace.details!.variablesJson![name] = JSON.stringify(
              o.variables![name],
            );
          } catch (e) {
            // This probably means that the value contains a circular reference,
            // causing `JSON.stringify()` to throw a TypeError:
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#Issue_with_JSON.stringify()_when_serializing_circular_references
            this.trace.details!.variablesJson![name] = JSON.stringify(
              '[Unable to convert value to JSON]',
            );
          }
        }
      });
    }

    const clientInfo = this.generateClientInfo(o.requestContext);
    if (clientInfo) {
      // While clientAddress could be a part of the protobuf, we'll ignore it for
      // now, since the backend does not group by it and Engine frontend will not
      // support it in the short term
      const { clientName, clientVersion, clientReferenceId } = clientInfo;
      // the backend makes the choice of mapping clientName => clientReferenceId if
      // no custom reference id is provided
      this.trace.clientVersion = clientVersion || '';
      this.trace.clientReferenceId = clientReferenceId || '';
      this.trace.clientName = clientName || '';
    }

    return () => {
      const { durationNs, rootNode } = this.treeBuilder.stopTiming();
      this.trace.durationNs = durationNs;
      this.trace.root = rootNode;
      this.trace.endTime = dateToTimestamp(new Date());

      this.trace.fullQueryCacheHit = !!o.requestContext.metrics
        .responseCacheHit;
      this.trace.forbiddenOperation = !!o.requestContext.metrics
        .forbiddenOperation;
      this.trace.registeredOperation = !!o.requestContext.metrics
        .registeredOperation;

      // If the user did not explicitly specify an operation name (which we
      // would have saved in `executionDidStart`), but the request pipeline made
      // it far enough to figure out what the operation name must be and store
      // it on requestContext.operationName, use that name.  (Note that this
      // depends on the assumption that the RequestContext passed to
      // requestDidStart, which does not yet have operationName, will be mutated
      // to add operationName later.)
      const operationName =
        this.explicitOperationName || o.requestContext.operationName || '';
      const documentAST = this.documentAST || o.requestContext.document;

      this.addTrace({
        operationName,
        queryHash,
        documentAST,
        queryString: this.queryString || '',
        trace: this.trace,
      });
    };
  }

  public executionDidStart(o: { executionArgs: ExecutionArgs }) {
    // If the operationName is explicitly provided, save it. Note: this is the
    // operationName provided by the user. It might be empty if they're relying on
    // the "just use the only operation I sent" behavior, even if that operation
    // has a name.
    //
    // It's possible that execution is about to fail because this operation
    // isn't actually in the document. We want to know the name in that case
    // too, which is why it's important that we save the name now, and not just
    // rely on requestContext.operationName (which will be null in this case).
    if (o.executionArgs.operationName) {
      this.explicitOperationName = o.executionArgs.operationName;
    }
    this.documentAST = o.executionArgs.document;
  }

  public willResolveField(
    _source: any,
    _args: { [argName: string]: any },
    _context: TContext,
    info: GraphQLResolveInfo,
  ): ((error: Error | null, result: any) => void) | void {
    return this.treeBuilder.willResolveField(info);
    // We could save the error into the trace during the end handler, but it
    // won't have all the information that graphql-js adds to it later, like
    // 'locations'.
  }

  public didEncounterErrors(errors: GraphQLError[]) {
    errors.forEach(err => {
      // In terms of reporting, errors can be re-written by the user by
      // utilizing the `rewriteError` parameter.  This allows changing
      // the message or stack to remove potentially sensitive information.
      // Returning `null` will result in the error not being reported at all.
      const errorForReporting = this.rewriteError(err);

      if (errorForReporting === null) {
        return;
      }

      this.addError(errorForReporting);
    });
  }

  private rewriteError(
    err: GraphQLError,
  ): GraphQLErrorOrMaskedErrorObject | null {
    // (DEPRECATE)
    // This relatively basic representation of an error is an artifact
    // introduced by https://github.com/apollographql/apollo-server/pull/1615.
    // Interesting, the implementation of that feature didn't actually
    // accomplish what the requestor had desired.  This functionality is now
    // being superceded by the `rewriteError` function, which is a more dynamic
    // implementation which multiple Engine users have been interested in.
    // When this `maskErrorDetails` is officially deprecated, this
    // `rewriteError` method can be changed to return `GraphQLError | null`,
    // and as noted in its definition, `GraphQLErrorOrMaskedErrorObject` can be
    // removed.
    if (this.options.maskErrorDetails) {
      return {
        message: '<masked>',
      };
    }

    if (typeof this.options.rewriteError === 'function') {
      // Before passing the error to the user-provided `rewriteError` function,
      // we'll make a shadow copy of the error so the user is free to change
      // the object as they see fit.

      // At this stage, this error is only for the purposes of reporting, but
      // this is even more important since this is still a reference to the
      // original error object and changing it would also change the error which
      // is returned in the response to the client.

      // For the clone, we'll create a new object which utilizes the exact same
      // prototype of the error being reported.
      const clonedError = Object.assign(
        Object.create(Object.getPrototypeOf(err)),
        err,
      );

      const rewrittenError = this.options.rewriteError(clonedError);

      // Returning an explicit `null` means the user is requesting that, in
      // terms of Engine reporting, the error be buried.
      if (rewrittenError === null) {
        return null;
      }

      // We don't want users to be inadvertently not reporting errors, so if
      // they haven't returned an explicit `GraphQLError` (or `null`, handled
      // above), then we'll report the error as usual.
      if (!(rewrittenError instanceof GraphQLError)) {
        return err;
      }

      return new GraphQLError(
        rewrittenError.message,
        err.nodes,
        err.source,
        err.positions,
        err.path,
        err.originalError,
        err.extensions,
      );
    }
    return err;
  }

  private addError(error: GraphQLErrorOrMaskedErrorObject): void {
    this.treeBuilder.addError(
      error.path,
      new Trace.Error({
        message: error.message,
        location: (error.locations || []).map(
          ({ line, column }) => new Trace.Location({ line, column }),
        ),
        json: JSON.stringify(error),
      }),
    );
  }
}

// Helpers for producing traces.

// Converts a JS Date into a Timestamp.
function dateToTimestamp(date: Date): google.protobuf.Timestamp {
  const totalMillis = +date;
  const millis = totalMillis % 1000;
  return new google.protobuf.Timestamp({
    seconds: (totalMillis - millis) / 1000,
    nanos: millis * 1e6,
  });
}

function defaultGenerateClientInfo({ request }: GraphQLRequestContext) {
  // Default to using the `apollo-client-x` header fields if present.
  // If none are present, fallback on the `clientInfo` query extension
  // for backwards compatibility.
  // The default value if neither header values nor query extension is
  // set is the empty String for all fields (as per protobuf defaults)
  if (
    request.http &&
    request.http.headers &&
    (request.http.headers.get(clientNameHeaderKey) ||
      request.http.headers.get(clientVersionHeaderKey) ||
      request.http.headers.get(clientReferenceIdHeaderKey))
  ) {
    return {
      clientName: request.http.headers.get(clientNameHeaderKey),
      clientVersion: request.http.headers.get(clientVersionHeaderKey),
      clientReferenceId: request.http.headers.get(clientReferenceIdHeaderKey),
    };
  } else if (request.extensions && request.extensions.clientInfo) {
    return request.extensions.clientInfo;
  } else {
    return {};
  }
}
