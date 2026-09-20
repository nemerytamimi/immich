import { describeRemoteError } from 'src/repositories/remote-storage/driver.js';

describe('describeRemoteError', () => {
  it('should keep a service error name, which is the whole diagnosis', () => {
    // What the AWS SDK hands over for a Contabo/Ceph list failure: a terse name,
    // a message that says nothing, and the useful parts hidden on the object.
    const error = {
      name: 'NoSuchKey',
      message: 'UnknownError',
      Code: 'NoSuchKey',
      Key: 'user-1/IMG_0001.jpg',
      $metadata: { httpStatusCode: 404, requestId: 'tx0000' },
    };

    expect(describeRemoteError(error)).toBe(
      'NoSuchKey UnknownError status=404 key=user-1/IMG_0001.jpg requestId=tx0000',
    );
  });

  it('should not prefix a plain error with a redundant "Error"', () => {
    expect(describeRemoteError(new Error('Connection refused'))).toBe('Connection refused');
  });

  it('should use a WebDAV-style status when there is no S3 metadata', () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(describeRemoteError(error)).toBe('Forbidden status=403');
  });

  it('should survive something that is not an error at all', () => {
    expect(describeRemoteError(undefined)).toBe('');
    expect(describeRemoteError('boom')).toBe('');
  });
});
