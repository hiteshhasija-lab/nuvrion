# Amazon Web Services: permissions, setup and troubleshooting

This guide covers the least-privilege IAM policy Nuvrion needs for EC2, how to create the account it uses, how to connect
it, and what the errors mean. For the other providers, and the table of how much each adapter has been proven, see
[connecting-providers.md](connecting-providers.md).

> **Status: written from the code, not yet run against a real AWS account.** The permission list below is exactly the set
> of EC2 calls the adapter makes (a test fails if the adapter gains a call that this guide does not list), and the adapter
> is tested against a fake SDK. It has never talked to AWS. The first live connection is the real validation: follow
> [Verify the permissions before you connect](#verify-the-permissions-before-you-connect) and report anything that differs.

## What Nuvrion does in AWS

| Nuvrion does | EC2 API call | IAM action |
|---|---|---|
| Test the connection | `DescribeInstances` (5 results) | `ec2:DescribeInstances` |
| Discover instances (on a schedule and on demand), paged 1,000 at a time | `DescribeInstances` | `ec2:DescribeInstances` |
| Start | `StartInstances` | `ec2:StartInstances` |
| Stop | `StopInstances` | `ec2:StopInstances` |
| Restart | `RebootInstances` | `ec2:RebootInstances` |
| Check that an operation reached its final state | waits on `DescribeInstances` (up to 5 minutes by default) | `ec2:DescribeInstances` |

That is all. Nuvrion does not create, terminate, resize, snapshot or tag instances, does not read volumes, security groups,
images or costs, and does not call any other AWS service. Suspend, force power-off, snapshots and media are not offered for
AWS machines. Tags that AWS reports are shown read-only in Nuvrion; nothing is written back.

`ec2:DescribeInstances` cannot be limited to particular instances (AWS accepts only `"Resource": "*"` for it), so the account
can always **see** every instance in the region. The three power actions can be limited, which is what the policy does.

## The policy

[policies/aws-nuvrion-iam-policy.json](policies/aws-nuvrion-iam-policy.json):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NuvrionReadInstances",
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    },
    {
      "Sid": "NuvrionPowerOperations",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:RebootInstances"
      ],
      "Resource": "arn:aws:ec2:*:*:instance/*"
    }
  ]
}
```

### Read-only

If Nuvrion should only look, attach the first statement only. Discovery, the inventory and alerts work; Start, Stop and
Restart fail with `NUV_AWS_PERMISSION_DENIED`, which is not retried.

### Narrowing the power actions

Both examples replace the second statement's `Resource` or add a `Condition`. Use one or both.

Only one region (the `aws:RequestedRegion` key applies to every service call):

```json
"Condition": { "StringEquals": { "aws:RequestedRegion": "eu-west-1" } }
```

Only instances you have marked for Nuvrion, by an AWS tag you set (any key and value you like):

```json
"Condition": { "StringEquals": { "aws:ResourceTag/nuvrion-managed": "true" } }
```

Nuvrion will still list the other instances (see above) but any power action on them is refused by AWS.

### Encrypted volumes

An instance whose EBS volumes are encrypted with a **customer-managed** KMS key may need the account to be allowed to use
that key before it will start. AWS documents this for the principal that starts the instance; this has not been tried with
Nuvrion. If Start fails with a permission error while Stop and Restart work, check the key policy first.

## Create the account

Nuvrion uses an **IAM user's access key**. It does not assume roles, read an instance profile or use the default credential
chain, so a role alone is not enough. Temporary credentials (an access key id, secret key and session token) are accepted
but are not refreshed; the connection fails when they expire. A long-lived key on a dedicated user is the practical choice.

With the AWS CLI (run as someone who can manage IAM):

```bash
aws iam create-policy --policy-name NuvrionEc2Operator --policy-document file://docs/policies/aws-nuvrion-iam-policy.json
aws iam create-user --user-name nuvrion
aws iam attach-user-policy --user-name nuvrion --policy-arn arn:aws:iam::<account-id>:policy/NuvrionEc2Operator
aws iam create-access-key --user-name nuvrion
```

The last command prints the **access key id and secret access key once**. In the console the same steps are: IAM, Policies,
Create policy (JSON tab); Users, Create user, no console access, attach the policy; Security credentials, Create access key,
choose "Application running outside AWS".

Do not give the user the console, other policies or `AdministratorAccess`.

## Verify the permissions before you connect

Using the new key (`aws configure --profile nuvrion`, or the environment variables), check what Nuvrion will need. A dry run
makes AWS check the permission without changing the instance:

```bash
aws ec2 describe-instances --max-results 5 --region <region> --profile nuvrion
aws ec2 stop-instances --dry-run --instance-ids <an-instance-id> --region <region> --profile nuvrion
```

`describe-instances` should list instances. The `--dry-run` call should answer `DryRunOperation` (allowed; nothing was
done). `UnauthorizedOperation` means the policy, a condition or a service control policy blocks it. Repeat with
`start-instances` and `reboot-instances` if you want to be thorough.

## Add the connection

1. **Connections > Add connection**.
2. Provider **Amazon Web Services**, connection type **Cloud API**.
3. **Endpoint** `https://ec2.<region>.amazonaws.com` (or leave it empty to use the AWS default for the region).
4. **Region**, for example `eu-west-1`. It is required. One connection covers **one region**: add one connection per region.
5. **Access key ID** in the user field, **secret access key** in the password field, and a **session token** only if you use
   temporary credentials.
6. Save, then **Test connection**, then **Discover**.

The secret is encrypted when saved and is never shown again. To rotate it, edit the connection and enter the new key; delete
the old key in IAM afterwards.

What you will see after discovery: the instance id and the `Name` tag as the name, state, instance type, availability
zone, private and public addresses, operating system (as AWS reports it), virtual CPUs (cores times threads) and tags.
**Memory and storage size are not shown** for AWS machines.

## What happens on a power action

- **Start** and **Restart** return as soon as AWS accepts the request; Nuvrion then waits (up to five minutes, the
  connection's `maxWaitTime` setting) for the instance to report `running` and records that as the verified result.
- **Stop** is an ordinary EC2 stop (a guest shutdown), not a forced one. Data on instance-store volumes is lost, as always
  with EC2. An instance-store-backed instance cannot be stopped at all.
- If the wait ends before the state is reached the task is marked `NUV_AWS_VERIFICATION_TIMEOUT` and is retried; if the
  process dies after AWS accepted the request, the task goes to *verification required* and the operation is never sent a
  second time.

## Troubleshooting

| Code | Meaning | What to do |
|---|---|---|
| `NUV_AWS_REGION_REQUIRED` | The connection has no region | Edit the connection and fill **Region** |
| `NUV_AWS_AUTH_FAILED` | AWS does not recognise the key, or the signature is wrong (wrong secret, deleted or deactivated key) | Check the key in IAM; re-enter the secret. Not retried, so a wrong key is not repeated |
| `NUV_AWS_PERMISSION_DENIED` | The key is valid but the policy does not allow the call | Compare the action in the message with the policy; check conditions and service control policies. Not retried |
| `NUV_AWS_RESOURCE_NOT_FOUND` | The instance no longer exists (terminated and removed) | Run discovery; it is marked missing |
| `NUV_AWS_THROTTLED` | AWS is limiting the request rate | Retried with backoff; the connection's health recovers by itself when AWS stops limiting |
| `NUV_AWS_UNAVAILABLE` | AWS answered with a server error | Retried with backoff; raises an alert that recovers by itself |
| `NUV_AWS_VERIFICATION_TIMEOUT` | AWS accepted the operation but the instance did not reach the state in time | Retried; check the instance's status checks in the AWS console |
| `NUV_AWS_REQUEST_FAILED` | Any other failure, with AWS's own message | Read the message |

Things the code does not classify, so they show as `NUV_AWS_REQUEST_FAILED` with AWS's message: an **expired temporary
session token** (the code lists only `AuthFailure`, `UnrecognizedClientException`, `InvalidClientTokenId` and
`SignatureDoesNotMatch` as authentication failures), and a region that is disabled for the account or an endpoint that does
not match the region. If the connection was healthy and goes critical on a day when nothing was changed, check the key's
expiry first.

## Limits to know about

- One region per connection; no cross-region view of one account in a single connection.
- Instances are discovered from `DescribeInstances` only, so Auto Scaling, load balancers, volumes and networks are not
  modelled, and an instance in `terminated` state is reported until AWS drops it (about an hour).
- No live throttling test has been run against AWS.
- Cost data is not collected.
