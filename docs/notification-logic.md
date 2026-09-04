# Why am I getting this notification?

ReviewNudge sends a digest only when a merge request contains work that the recipient is
expected to do. Being listed as a GitLab participant is not, by itself, enough.

## Reviewer

A reviewer is notified when their review is still pending. A reviewer who has already
reviewed is not chased again unless new commits arrive that require another look.

## Author or assignee

The author or an assignee is notified when they need to act: a reviewer requested changes,
an unresolved discussion needs their reply, they were explicitly mentioned without replying,
or an approved merge request is ready for them to merge.

An author or assignee is **not** notified simply because the merge request received a new
commit or comment while it is waiting for a reviewer.

## Other participants

People who only commented on an MR are notified only when the activity directly involves
them: they are mentioned and have not replied, or somebody replies to a thread they opened
that remains unresolved. Passive participation does not create a notification.

The participant list shown in a notification is context about the MR. It does not mean that
every listed person is expected to take action.

## Why an MR can appear in more than one person’s digest

A merge request can require different actions from different people at the same time. For
example, the reviewer may receive a review request while the author receives nothing until
the review produces requested changes. Each digest is calculated independently for its
recipient.

If a notification still looks wrong, use the merge request link to check the current GitLab
review state and open an issue from the notification footer.
