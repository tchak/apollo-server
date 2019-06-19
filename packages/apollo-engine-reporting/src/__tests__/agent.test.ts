import {
  signatureCacheKey,
  handleLegacyOptions,
  EngineReportingOptions,
} from '../agent';

describe('signature cache key', () => {
  it('generates without the operationName', () => {
    expect(signatureCacheKey('abc123', '')).toEqual('abc123');
  });

  it('generates without the operationName', () => {
    expect(signatureCacheKey('abc123', 'myOperation')).toEqual(
      'abc123:myOperation',
    );
  });
});

describe("test handleLegacyOptions(), which converts the deprecated privateVariable and privateHeaders options to the new options' formats", () => {
  it('Case 1: privateVariables/privateHeaders == False; same as sendAll', () => {
    const optionsPrivateFalse: EngineReportingOptions<any> = {
      privateVariables: false,
      privateHeaders: false,
    };
    handleLegacyOptions(optionsPrivateFalse);
    expect(optionsPrivateFalse.privateVariables).toBe(undefined);
    expect(optionsPrivateFalse.sendVariableValues).toEqual({ sendAll: true });
    expect(optionsPrivateFalse.privateHeaders).toBe(undefined);
    expect(optionsPrivateFalse.sendHeaders).toEqual({ sendAll: true });
  });

  it('Case 2: privateVariables/privateHeaders == True; same as sendNone', () => {
    const optionsPrivateTrue: EngineReportingOptions<any> = {
      privateVariables: true,
      privateHeaders: true,
    };
    handleLegacyOptions(optionsPrivateTrue);
    expect(optionsPrivateTrue.privateVariables).toBe(undefined);
    expect(optionsPrivateTrue.sendVariableValues).toEqual({ sendNone: true });
    expect(optionsPrivateTrue.privateHeaders).toBe(undefined);
    expect(optionsPrivateTrue.sendHeaders).toEqual({ sendNone: true });
  });

  it('Case 3: privateVariables/privateHeaders set to an array', () => {
    const privateArray: Array<String> = ['t1', 't2'];
    const optionsPrivateArray: EngineReportingOptions<any> = {
      privateVariables: privateArray,
      privateHeaders: privateArray,
    };
    handleLegacyOptions(optionsPrivateArray);
    expect(optionsPrivateArray.privateVariables).toBe(undefined);
    expect(optionsPrivateArray.sendVariableValues).toEqual({
      exceptNames: privateArray,
    });
    expect(optionsPrivateArray.privateHeaders).toBe(undefined);
    expect(optionsPrivateArray.sendHeaders).toEqual({
      exceptNames: privateArray,
    });
  });

  it('Case 4: throws error when both the new and old options are set', () => {
    const optionsBothVariables: EngineReportingOptions<any> = {
      privateVariables: true,
      sendVariableValues: { sendNone: true },
    };
    expect(() => {
      handleLegacyOptions(optionsBothVariables);
    }).toThrow();
    const optionsBothHeaders: EngineReportingOptions<any> = {
      privateHeaders: true,
      sendHeaders: { sendNone: true },
    };
    expect(() => {
      handleLegacyOptions(optionsBothHeaders);
    }).toThrow();
  });

  it('Case 5: the passed in options are not modified if deprecated fields were not set', () => {
    const optionsNotDeprecated: EngineReportingOptions<any> = {
      sendVariableValues: { exceptNames: ['test'] },
      sendHeaders: true,
    };
    const output: EngineReportingOptions<any> = {
      sendVariableValues: { exceptNames: ['test'] },
      sendHeaders: true,
    };
    handleLegacyOptions(optionsNotDeprecated);
    expect(optionsNotDeprecated).toEqual(output);

    const emptyInput: EngineReportingOptions<any> = {};
    handleLegacyOptions(emptyInput);
    expect(emptyInput).toEqual({});
  });
});
